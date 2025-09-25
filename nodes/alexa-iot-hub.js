'use strict';

module.exports = function(RED) {
    if (!RED || !RED.nodes || !RED.nodes.registerType) {
        console.error('Node-RED runtime (RED) is undefined. Cannot register alexa-iot-hub node.');
        return;
    }

    const express = require('express');
    const helmet = require('helmet');
    const rateLimit = require('express-rate-limit');
    const { Server: SSDPServer } = require('node-ssdp');
    const ip = require('ip');
    const https = require('https');
    const http = require('http');
    const fs = require('fs');
    const path = require('path');

    function AlexaIotHubNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const port = parseInt(config.port, 10) || 80;
        const debug = config.debug || false;
        const certPath = config.certPath || path.join(RED.settings.userDir, 'server.cert');
        const keyPath = config.keyPath || path.join(RED.settings.userDir, 'server.key');

        const app = express();
        app.use(helmet());
        app.use(express.json({ limit: '10kb' }));

        app.use(rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 100,
            message: 'Too many requests, please try again later.'
        }));

        // SSDP Configuration (Hue Emulation)
        const localIp = ip.address();
        const bridgeUuid = `2f402f80-da50-11e1-9b23-${node.id}`;
        const ssdp = new SSDPServer({
            location: `http://${localIp}:${port}/description.xml`,  // Use HTTPS in location if port 443
            udn: `uuid:${bridgeUuid}`,
            sourcePort: 1900,
            adInterval: 30000, // Hue broadcasts every 30s
            suppressRootDeviceAnnouncements: false
        });

        ssdp.addUSN('upnp:rootdevice');
        ssdp.addUSN('urn:schemas-upnp-org:device:basic:1');
        ssdp.addUSN('urn:schemas-upnp-org:device:PhilipsHueBridge:1');
        ssdp.addUSN(`uuid:${bridgeUuid}`);

        ssdp.addCustomHeader('hue-bridgeid', node.id.toUpperCase());
        ssdp.addCustomHeader('BRIDGEID', node.id.toUpperCase());
        ssdp.addCustomHeader('SERVER', 'Linux/3.14.0 UPnP/1.0 PhilipsHue/1.0');

        ssdp.on('response', (headers, statusCode, rinfo) => {
            if (debug) node.debug(`SSDP response sent to ${rinfo.address}: ${JSON.stringify(headers)}`);
        });

        ssdp.on('advertise-alive', (headers) => {
            if (debug) node.debug(`SSDP advertise-alive: ${JSON.stringify(headers)}`);
        });

        // Serve UPnP description.xml
        app.get('/description.xml', (req, res) => {
            const protocol = port === 443 ? 'https' : 'http';
            res.set('Content-Type', 'text/xml');
            res.send(`
                <?xml version="1.0" encoding="UTF-8"?>
                <root xmlns="urn:schemas-upnp-org:device-1-0">
                    <specVersion>
                        <major>1</major>
                        <minor>0</minor>
                    </specVersion>
                    <URLBase>${protocol}://${localIp}:${port}/</URLBase>
                    <device>
                        <deviceType>urn:schemas-upnp-org:device:PhilipsHueBridge:1</deviceType>
                        <friendlyName>Philips hue (${localIp})</friendlyName>
                        <manufacturer>Signify</manufacturer>
                        <manufacturerURL>https://www.philips-hue.com</manufacturerURL>
                        <modelDescription>Philips Hue Bridge</modelDescription>
                        <modelName>Philips hue bridge 2015</modelName>
                        <modelNumber>BSB002</modelNumber>
                        <serialNumber>${node.id}</serialNumber>
                        <UDN>uuid:${bridgeUuid}</UDN>
                        <iconList>
                            <icon>
                                <mimetype>image/png</mimetype>
                                <width>48</width>
                                <height>48</height>
                                <depth>24</depth>
                                <url>/icon.png</url>
                            </icon>
                        </iconList>
                    </device>
                </root>
            `);
            node.log(`Served description.xml to ${req.ip}`);
        });

        // Generate device list (Hue-compatible) with sequential indexing
        function generateDeviceList() {
            const lights = {};
            let index = 1;
            const deviceMap = {};  // Map node.id to index for lookup
            RED.nodes.eachNode(n => {
                if (n.type === 'alexa-iot-device' && RED.nodes.getNode(n.hub) === node) {
                    const uniqueid = `${node.id.slice(0, 8)}:${node.id.slice(8, 12)}:${node.id.slice(12, 16)}:${node.id.slice(16, 20)}:${node.id.slice(20, 24)}:${node.id.slice(24, 28)}:${node.id.slice(28, 32)}:${index.toString(16).padStart(2, '0')}-01`;
                    lights[index.toString()] = {
                        state: {
                            on: false,
                            bri: 254,
                            hue: 0,
                            sat: 254,
                            effect: 'none',
                            xy: [0.4448, 0.4066],
                            ct: 153,
                            alert: 'none',
                            colormode: 'xy',
                            mode: 'homeautomation',
                            reachable: true
                        },
                        swupdate: {
                            state: 'noupdates',
                            lastinstall: new Date().toISOString()
                        },
                        type: 'Extended color light',
                        name: n.name || `Light ${index}`,
                        modelid: 'LCT015',
                        manufacturername: 'Signify',
                        productname: 'Hue color lamp',
                        capabilities: {
                            certified: true,
                            control: {
                                mindimlevel: 1000,
                                maxlumen: 800,
                                colorgamuttype: 'C',
                                colorgamut: [[0.6915, 0.3083], [0.1367, 0.4041], [0.4, 0.4]],
                                ct: { min: 153, max: 500 }
                            },
                            streaming: { renderer: true, proxy: false }
                        },
                        config: {
                            archetype: 'huebulb',
                            function: 'mixed',
                            direction: 'omnidirectional',
                            startup: { mode: 'safety', configured: true }
                        },
                        uniqueid: uniqueid,
                        swversion: '1.46.13_r26312'
                    };
                    deviceMap[n.id] = index.toString();
                    index++;
                }
            });
            node.deviceMap = deviceMap;  // Store for control lookup
            return lights;
        }

        // Handle Hue API user creation
        app.post('/api', (req, res) => {
            node.log(`Hue API user creation request from ${req.ip}: ${JSON.stringify(req.body)}`);
            const devicetype = req.body?.devicetype || 'Echo';
            res.json([{
                success: {
                    username: `node-red-alexa-${node.id}`,
                    clientkey: `node-red-alexa-${node.id}`
                }
            }]);
            node.log(`Hue API user created: node-red-alexa-${node.id}`);
        });

        // Handle Hue API full config
        app.get('/api/:userId', (req, res) => {
            const userId = req.params.userId;
            node.log(`Hue API full config request from ${req.ip} for user ${userId}`);
            const lights = generateDeviceList();
            const response = {
                lights: lights,
                groups: {},
                config: {
                    name: 'Philips hue',
                    zigbeechannel: 15,
                    bridgeid: node.id.toUpperCase(),
                    mac: '00:17:88:AA:BB:CC',
                    dhcp: true,
                    ipaddress: localIp,
                    netmask: '255.255.255.0',
                    gateway: localIp.split('.').slice(0, 3).join('.') + '.1',
                    proxyaddress: 'none',
                    proxyport: 0,
                    UTC: new Date().toISOString(),
                    modelid: 'BSB002',
                    datastoreversion: '87',
                    swversion: '1941132080',
                    apiversion: '1.40.0',
                    swupdate: {
                        updatestate: 0,
                        checkforupdate: false,
                        devicetypes: { bridge: false, lights: [], sensors: [] },
                        url: '',
                        text: '',
                        notify: false
                    },
                    linkbutton: true,
                    portalservices: false,
                    portalconnection: 'disconnected',
                    portalstate: {
                        signedon: false,
                        incoming: false,
                        outgoing: false,
                        communication: 'disconnected'
                    },
                    factorynew: false,
                    replacesbridgeid: null,
                    backup: { status: 'idle', errorcode: 0 },
                    whitelist: {
                        [userId]: {
                            'last use date': new Date().toISOString(),
                            'create date': new Date().toISOString(),
                            name: 'Echo'
                        }
                    }
                },
                schedules: {},
                scenes: {},
                rules: {},
                sensors: {},
                resourcelinks: {}
            };
            res.json(response);
            if (debug) node.log(`Hue API full config response: ${JSON.stringify(response, null, 2)}`);
        });

        // Handle Hue API config
        app.get('/api/config', (req, res) => {
            node.log(`Hue API config request from ${req.ip}`);
            res.json({
                name: 'Philips hue',
                zigbeechannel: 15,
                bridgeid: node.id.toUpperCase(),
                mac: '00:17:88:AA:BB:CC',
                dhcp: true,
                ipaddress: localIp,
                netmask: '255.255.255.0',
                gateway: localIp.split('.').slice(0, 3).join('.') + '.1',
                proxyaddress: 'none',
                proxyport: 0,
                UTC: new Date().toISOString(),
                modelid: 'BSB002',
                datastoreversion: '87',
                swversion: '1941132080',
                apiversion: '1.40.0',
                swupdate: {
                    updatestate: 0,
                    checkforupdate: false,
                    devicetypes: { bridge: false, lights: [], sensors: [] },
                    url: '',
                    text: '',
                    notify: false
                },
                linkbutton: true,
                portalservices: false,
                portalconnection: 'disconnected',
                portalstate: {
                    signedon: false,
                    incoming: false,
                    outgoing: false,
                    communication: 'disconnected'
                },
                factorynew: false,
                replacesbridgeid: null
            });
            if (debug) node.log(`Hue API config response sent`);
        });

        // Handle Hue API discovery
        app.get('/api/:userId/lights', (req, res) => {
            const userId = req.params.userId;
            node.log(`Hue API discovery request from ${req.ip} for user ${userId}`);
            const lights = generateDeviceList();
            res.json(lights);
            if (debug) node.log(`Hue API lights response: ${JSON.stringify(lights, null, 2)}`);
        });

        // Handle Hue API single light probe
        app.get('/api/:userId/lights/:deviceId', (req, res) => {
            const userId = req.params.userId;
            const deviceId = req.params.deviceId;
            node.log(`Hue API light probe from ${req.ip} for user ${userId}, device ${deviceId}`);
            const lights = generateDeviceList();
            const light = lights[deviceId];

            if (light) {
                res.json(light);
                if (debug) node.log(`Hue API light response: ${JSON.stringify(light, null, 2)}`);
            } else {
                res.status(404).json([{ error: { type: 1, address: `/lights/${deviceId}`, description: `Device ${deviceId} not found` } }]);
                node.log(`Hue API light not found: ${deviceId}`);
            }
        });

        // Handle Hue API control
        app.put('/api/:userId/lights/:deviceId/state', (req, res) => {
            const userId = req.params.userId;
            const deviceId = req.params.deviceId;
            const body = req.body;
            node.log(`Hue API control request from ${req.ip} for user ${userId}, device ${deviceId}: ${JSON.stringify(body)}`);

            generateDeviceList();  // Refresh map
            const deviceNodeId = Object.keys(node.deviceMap).find(key => node.deviceMap[key] === deviceId);
            let deviceNode = null;
            if (deviceNodeId) {
                deviceNode = RED.nodes.getNode(deviceNodeId);
            }

            if (!deviceNode) {
                res.status(404).json([{ error: { type: 1, address: `/lights/${deviceId}`, description: `Device ${deviceId} not found` } }]);
                node.log(`Hue API control failed: Device ${deviceId} not found`);
                return;
            }

            let topic, payload;
            if (body.on !== undefined) {
                topic = 'power';
                payload = body.on ? 'ON' : 'OFF';
            } else if (body.bri !== undefined) {
                topic = 'brightness';
                payload = Math.round((body.bri / 254) * 100);
            } else if (body.hue !== undefined && body.sat !== undefined) {
                topic = 'color';
                payload = { hue: body.hue, saturation: body.sat / 254, brightness: (body.bri || 254) / 254 };
            } else if (body.xy) {
                topic = 'color';
                payload = { xy: body.xy, brightness: (body.bri || 254) / 254 };
            } else if (body.ct) {
                topic = 'color';
                payload = { ct: body.ct, brightness: (body.bri || 254) / 254 };
            }

            if (topic && payload) {
                deviceNode.receive({ topic, payload });
                res.json([{ success: { [`/lights/${deviceId}/state/${Object.keys(body)[0]}`]: body[Object.keys(body)[0]] } }]);
                node.log(`Hue API control success: topic=${topic}, payload=${JSON.stringify(payload)}`);
            } else {
                res.status(400).json([{ error: { type: 6, address: `/lights/${deviceId}/state`, description: 'Invalid or missing parameters' } }]);
                node.log(`Hue API control failed: Invalid or missing parameters`);
            }
        });

        // Log all requests
        app.use((req, res, next) => {
            if (debug) node.log(`Request from ${req.ip}: ${req.method} ${req.url} Headers: ${JSON.stringify(req.headers)}`);
            next();
        });

        // Handle root endpoint
        app.get('/', (req, res) => {
            res.status(404).json({ error: 'Not found, use Hue API endpoints' });
        });

        // Start server (HTTP or HTTPS)
        let server;
        const protocol = port === 443 ? 'https' : 'http';
        const locationProtocol = port === 443 ? 'https' : 'http';
        ssdp.location = `${locationProtocol}://${localIp}:${port}/description.xml`;  // Update SSDP location dynamically

        try {
            if (port === 443) {
                if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
                    const options = {
                        key: fs.readFileSync(keyPath),
                        cert: fs.readFileSync(certPath)
                    };
                    server = https.createServer(options, app).listen(port, () => {
                        node.log(`Alexa IOT Hub listening on HTTPS port ${port}`);
                        node.status({ fill: 'green', shape: 'dot', text: `listening on ${port} (HTTPS)` });
                    });
                } else {
                    node.warn(`HTTPS requested (port 443) but certs not found at ${keyPath} or ${certPath}. Falling back to HTTP on port 443 (insecure). Generate certs for secure HTTPS.`);
                    server = http.createServer(app).listen(port, () => {
                        node.log(`Alexa IOT Hub listening on HTTP port ${port} (insecure fallback)`);
                        node.status({ fill: 'yellow', shape: 'ring', text: `listening on ${port} (HTTP fallback)` });
                    });
                }
            } else {
                server = http.createServer(app).listen(port, () => {
                    node.log(`Alexa IOT Hub listening on HTTP port ${port}`);
                    node.status({ fill: 'green', shape: 'dot', text: `listening on ${port}` });
                });
            }
            ssdp.start();
            node.log('SSDP server started');
        } catch (err) {
            node.error(`Failed to start server on port ${port}: ${err.message}`);
            node.status({ fill: 'red', shape: 'ring', text: `error: ${err.message}` });
            return;
        }

        node.on('close', () => {
            if (server) {
                server.close();
                node.log('Alexa IOT Hub server closed');
            }
            if (ssdp) {
                ssdp.stop();
                node.log('SSDP server stopped');
            }
            node.status({});
        });
    }

    try {
        RED.nodes.registerType('alexa-iot-hub', AlexaIotHubNode);
    } catch (err) {
        console.error(`Failed to register alexa-iot-hub node: ${err.message}`);
    }
};
