'use strict';

module.exports = function(RED) {
    if (!RED || !RED.nodes || !RED.nodes.registerType) {
        console.error('Node-RED runtime (RED) is undefined. Cannot register alexa-iot-hub node.');
        return;
    }

    const express = require('express');
    const helmet = require('helmet');
    const rateLimit = require('express-rate-limit');
    const sanitizeHtml = require('sanitize-html');
    const { Server: SSDPServer } = require('node-ssdp');

    function AlexaIotHubNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const port = parseInt(config.port, 10) || 80;
        const debug = config.debug || false;

        const app = express();
        app.use(helmet());
        app.use(express.json({ limit: '10kb' }));

        app.use(rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 100,
            message: 'Too many requests, please try again later.'
        }));

        // SSDP Configuration (Hue Emulation)
        const localIp = require('ip').address();
        const ssdp = new SSDPServer({
            location: `http://${localIp}:${port}/description.xml`,
            udn: `uuid:2f402f80-da50-11e1-9b23-${node.id}`,
            sourcePort: 1900,
            adInterval: 10000,
            customHeaders: {
                'hue-bridgeid': node.id.toUpperCase(),
                'BRIDGEID': node.id.toUpperCase()
            }
        });

        ssdp.addUSN('upnp:rootdevice');
        ssdp.addUSN('urn:schemas-upnp-org:device:basic:1');
        ssdp.addUSN('urn:philips-hue:device:bridge:1');
        ssdp.addUSN('ssdp:all');

        ssdp.on('response', (headers, statusCode, rinfo) => {
            node.debug(`SSDP response sent to ${rinfo.address}: ${JSON.stringify(headers)}`);
        });

        ssdp.on('advertise-alive', (headers) => {
            node.debug(`SSDP advertise-alive: ${JSON.stringify(headers)}`);
        });

        // Serve UPnP description.xml
        app.get('/description.xml', (req, res) => {
            res.set('Content-Type', 'text/xml');
            res.send(`
                <?xml version="1.0"?>
                <root xmlns="urn:schemas-upnp-org:device-1-0">
                    <specVersion>
                        <major>1</major>
                        <minor>0</minor>
                    </specVersion>
                    <URLBase>http://${localIp}:${port}/</URLBase>
                    <device>
                        <deviceType>urn:philips-hue:device:bridge:1</deviceType>
                        <friendlyName>Node-RED Alexa Hub (${node.id})</friendlyName>
                        <manufacturer>Node-RED</manufacturer>
                        <manufacturerURL>https://nodered.org</manufacturerURL>
                        <modelDescription>Node-RED Alexa IOT Hub</modelDescription>
                        <modelName>Philips hue bridge 2015</modelName>
                        <modelNumber>BSB002</modelNumber>
                        <serialNumber>${node.id}</serialNumber>
                        <UDN>uuid:2f402f80-da50-11e1-9b23-${node.id}</UDN>
                        <iconList>
                            <icon>
                                <mimetype>image/png</mimetype>
                                <width>48</width>
                                <height>48</height>
                                <depth>24</depth>
                                <url>/icon.png</url>
                            </icon>
                        </iconList>
                        <serviceList>
                            <service>
                                <serviceType>urn:schemas-upnp-org:service:SmartHome:1</serviceType>
                                <serviceId>urn:upnp-org:serviceId:SmartHome1</serviceId>
                                <controlURL>/alexa</controlURL>
                                <eventSubURL>/alexa</eventSubURL>
                                <SCPDURL>/alexa</SCPDURL>
                            </service>
                        </serviceList>
                    </device>
                </root>
            `);
            node.log(`Served description.xml to ${req.ip}`);
        });

        // Serve Hue-like device list at /api/description.xml
        app.get('/api/description.xml', (req, res) => {
            node.log(`Hue API description request from ${req.ip}`);
            const lights = {};
            let index = 1;
            RED.nodes.eachNode(n => {
                if (n.type === 'alexa-iot-device' && RED.nodes.getNode(n.hub) === node) {
                    lights[index] = {
                        state: {
                            on: false,
                            bri: 100,
                            hue: 0,
                            sat: 0,
                            reachable: true
                        },
                        type: 'Extended color light',
                        name: n.name,
                        modelid: 'LCT001',
                        manufacturername: 'Node-RED',
                        uniqueid: n.endpointId || n.id
                    };
                    index++;
                }
            });
            res.json(lights);
            node.log(`Hue API description response: ${JSON.stringify(lights)}`);
        });

        // Handle Hue API user creation
        app.post('/api', (req, res) => {
            node.log(`Hue API user creation request from ${req.ip}`);
            res.json([{
                success: {
                    username: 'node-red-alexa-' + node.id,
                    clientkey: 'node-red-alexa-' + node.id
                }
            }]);
            node.log(`Hue API user created: node-red-alexa-${node.id}`);
        });

        // Handle Hue API discovery
        app.get('/api/:userId/lights', (req, res) => {
            const userId = req.params.userId;
            node.log(`Hue API discovery request from ${req.ip} for user ${userId}`);
            const lights = {};
            let index = 1;
            RED.nodes.eachNode(n => {
                if (n.type === 'alexa-iot-device' && RED.nodes.getNode(n.hub) === node) {
                    lights[index] = {
                        state: {
                            on: false,
                            bri: 100,
                            hue: 0,
                            sat: 0,
                            reachable: true
                        },
                        type: 'Extended color light',
                        name: n.name,
                        modelid: 'LCT001',
                        manufacturername: 'Node-RED',
                        uniqueid: n.endpointId || n.id
                    };
                    index++;
                }
            });

            res.json(lights);
            node.log(`Hue API lights response: ${JSON.stringify(lights)}`);
        });

        // Handle Hue API single light probe
        app.get('/api/:userId/lights/:deviceId', (req, res) => {
            const userId = req.params.userId;
            const deviceId = req.params.deviceId;
            node.log(`Hue API light probe from ${req.ip} for user ${userId}, device ${deviceId}`);
            let light = null;
            let foundIndex = null;
            RED.nodes.eachNode(n => {
                if (n.type === 'alexa-iot-device' && RED.nodes.getNode(n.hub) === node) {
                    const id = n.endpointId || n.id;
                    if (deviceId === id || deviceId === String(Object.keys(lights).find(key => lights[key].uniqueid === id))) {
                        light = {
                            state: {
                                on: false,
                                bri: 100,
                                hue: 0,
                                sat: 0,
                                reachable: true
                            },
                            type: 'Extended color light',
                            name: n.name,
                            modelid: 'LCT001',
                            manufacturername: 'Node-RED',
                            uniqueid: id
                        };
                        foundIndex = Object.keys(lights).find(key => lights[key].uniqueid === id) || deviceId;
                    }
                }
            });

            if (light) {
                res.json(light);
                node.log(`Hue API light response: ${JSON.stringify(light)}`);
            } else {
                res.status(404).json({ error: `Device ${deviceId} not found` });
                node.log(`Hue API light not found: ${deviceId}`);
            }
        });

        // Handle Hue API control
        app.put('/api/:userId/lights/:deviceId/state', (req, res) => {
            const userId = req.params.userId;
            const deviceId = req.params.deviceId;
            const body = req.body;
            node.log(`Hue API control request from ${req.ip} for user ${userId}, device ${deviceId}: ${JSON.stringify(body)}`);
            let deviceNode = null;
            RED.nodes.eachNode(n => {
                if (n.type === 'alexa-iot-device' && RED.nodes.getNode(n.hub) === node) {
                    const id = n.endpointId || n.id;
                    if (deviceId === id || deviceId === String(Object.keys(lights).find(key => lights[key].uniqueid === id))) {
                        deviceNode = RED.nodes.getNode(n.id);
                    }
                }
            });

            if (!deviceNode) {
                res.status(404).json([{ error: { type: 3, address: `/lights/${deviceId}`, description: `Device ${deviceId} not found` } }]);
                node.log(`Hue API control failed: Device ${deviceId} not found`);
                return;
            }

            let topic, payload;
            if (body.on !== undefined) {
                topic = 'power';
                payload = body.on ? 'ON' : 'OFF';
            } else if (body.bri !== undefined) {
                topic = 'brightness';
                payload = Math.round((body.bri / 254) * 100); // Hue bri: 0-254, Alexa: 0-100
            } else if (body.hue !== undefined && body.sat !== undefined) {
                topic = 'color';
                payload = { hue: body.hue, saturation: body.sat / 254, brightness: (body.bri || 100) / 254 };
            }

            if (topic && payload) {
                deviceNode.receive({ topic, payload });
                res.json([{ success: { [`/lights/${deviceId}/state/${topic}`]: payload } }]);
                node.log(`Hue API control success: topic=${topic}, payload=${JSON.stringify(payload)}`);
            } else {
                res.status(400).json([{ error: { type: 6, address: `/lights/${deviceId}/state`, description: 'Invalid or missing parameters' } }]);
                node.log(`Hue API control failed: Invalid or missing parameters`);
            }
        });

        // Log all requests
        app.use((req, res, next) => {
            node.log(`Request from ${req.ip}: ${req.method} ${req.url} Headers: ${JSON.stringify(req.headers)}`);
            next();
        });

        // Handle unexpected GET /
        app.get('/', (req, res) => {
            res.status(404).json({ error: 'Not found, use POST /alexa for Alexa directives' });
        });

        app.post('/alexa', (req, res) => {
            try {
                const directive = req.body?.directive;
                if (!directive || !directive.header || !directive.header.namespace) {
                    res.status(400).json({
                        event: {
                            header: {
                                namespace: 'Alexa',
                                name: 'ErrorResponse',
                                payloadVersion: '3',
                                messageId: directive?.header?.messageId || 'unknown'
                            },
                            payload: {
                                type: 'INVALID_DIRECTIVE',
                                message: 'Missing or invalid directive'
                            }
                        }
                    });
                    return;
                }

                const { namespace, name, messageId, correlationToken } = directive.header;
                const endpointId = directive.endpoint?.endpointId;

                if (namespace === 'Alexa.Discovery' && name === 'Discover') {
                    const devices = [];
                    const lights = {};
                    let index = 1;
                    RED.nodes.eachNode(n => {
                        if (n.type === 'alexa-iot-device' && RED.nodes.getNode(n.hub) === node) {
                            const id = n.endpointId || n.id;
                            devices.push({
                                endpointId: id,
                                friendlyName: n.name,
                                description: `Node-RED ${n.name}`,
                                manufacturerName: 'Node-RED',
                                displayCategories: ['LIGHT', 'SWITCH'],
                                capabilities: [
                                    {
                                        type: 'AlexaInterface',
                                        interface: 'Alexa',
                                        version: '3'
                                    },
                                    {
                                        type: 'AlexaInterface',
                                        interface: 'Alexa.PowerController',
                                        version: '3',
                                        properties: {
                                            supported: [{ name: 'powerState' }],
                                            proactivelyReported: false,
                                            retrievable: true
                                        }
                                    },
                                    {
                                        type: 'AlexaInterface',
                                        interface: 'Alexa.BrightnessController',
                                        version: '3',
                                        properties: {
                                            supported: [{ name: 'brightness' }],
                                            proactivelyReported: false,
                                            retrievable: true
                                        }
                                    },
                                    {
                                        type: 'AlexaInterface',
                                        interface: 'Alexa.ColorController',
                                        version: '3',
                                        properties: {
                                            supported: [{ name: 'color' }],
                                            proactivelyReported: false,
                                            retrievable: true
                                        }
                                    }
                                ]
                            });
                            lights[index] = {
                                state: {
                                    on: false,
                                    bri: 100,
                                    hue: 0,
                                    sat: 0,
                                    reachable: true
                                },
                                type: 'Extended color light',
                                name: n.name,
                                modelid: 'LCT001',
                                manufacturername: 'Node-RED',
                                uniqueid: id
                            };
                            index++;
                        }
                    });

                    res.json({
                        event: {
                            header: {
                                namespace: 'Alexa.Discovery',
                                name: 'Discover.Response',
                                payloadVersion: '3',
                                messageId
                            },
                            payload: { endpoints: devices }
                        }
                    });

                    if (debug) {
                        node.log(`Discovery response: ${JSON.stringify(devices)}`);
                    }
                    return;
                }

                if (!endpointId) {
                    res.status(400).json({
                        event: {
                            header: {
                                namespace: 'Alexa',
                                name: 'ErrorResponse',
                                payloadVersion: '3',
                                messageId,
                                correlationToken
                            },
                            payload: {
                                type: 'INVALID_DIRECTIVE',
                                message: 'Missing endpointId'
                            }
                        }
                    });
                    return;
                }

                let deviceNode = null;
                RED.nodes.eachNode(n => {
                    if (n.type === 'alexa-iot-device' && (n.endpointId || n.id) === endpointId && RED.nodes.getNode(n.hub) === node) {
                        deviceNode = RED.nodes.getNode(n.id);
                    }
                });

                if (!deviceNode) {
                    res.status(404).json({
                        event: {
                            header: {
                                namespace: 'Alexa',
                                name: 'ErrorResponse',
                                payloadVersion: '3',
                                messageId,
                                correlationToken
                            },
                            payload: {
                                type: 'ENDPOINT_UNREACHABLE',
                                message: `Device ${endpointId} not found`
                            }
                        }
                    });
                    return;
                }

                let topic, payload;
                if (namespace === 'Alexa.PowerController' && (name === 'TurnOn' || name === 'TurnOff')) {
                    topic = 'power';
                    payload = name === 'TurnOn' ? 'ON' : 'OFF';
                } else if (namespace === 'Alexa.BrightnessController' && name === 'SetBrightness') {
                    topic = 'brightness';
                    payload = directive.payload.brightness;
                } else if (namespace === 'Alexa.BrightnessController' && name === 'AdjustBrightness') {
                    topic = 'brightness';
                    payload = directive.payload.brightnessDelta;
                } else if (namespace === 'Alexa.ColorController' && name === 'SetColor') {
                    topic = 'color';
                    payload = directive.payload.color;
                } else {
                    res.status(400).json({
                        event: {
                            header: {
                                namespace: 'Alexa',
                                name: 'ErrorResponse',
                                payloadVersion: '3',
                                messageId,
                                correlationToken
                            },
                            payload: {
                                type: 'INVALID_DIRECTIVE',
                                message: `Unsupported directive: ${namespace}.${name}`
                            }
                        }
                    });
                    return;
                }

                deviceNode.receive({ topic, payload });

                res.json({
                    event: {
                        header: {
                            namespace: 'Alexa',
                            name: 'Response',
                            payloadVersion: '3',
                            messageId,
                            correlationToken
                        },
                        endpoint: { endpointId },
                        payload: {}
                    },
                    context: {
                        properties: [
                            namespace === 'Alexa.PowerController' ? {
                                namespace: 'Alexa.PowerController',
                                name: 'powerState',
                                value: payload,
                                timeOfSample: new Date().toISOString(),
                                uncertaintyInMilliseconds: 0
                            } : namespace === 'Alexa.BrightnessController' ? {
                                namespace: 'Alexa.BrightnessController',
                                name: 'brightness',
                                value: payload,
                                timeOfSample: new Date().toISOString(),
                                uncertaintyInMilliseconds: 0
                            } : {
                                namespace: 'Alexa.ColorController',
                                name: 'color',
                                value: payload,
                                timeOfSample: new Date().toISOString(),
                                uncertaintyInMilliseconds: 0
                            }
                        ]
                    }
                });

                if (debug) {
                    node.log(`Processed ${namespace}.${name} for ${endpointId}: topic=${topic}, payload=${JSON.stringify(payload)}`);
                }
            } catch (err) {
                node.error(`Error processing directive: ${err.message}`);
                res.status(500).json({
                    event: {
                        header: {
                            namespace: 'Alexa',
                            name: 'ErrorResponse',
                            payloadVersion: '3',
                            messageId: directive?.header?.messageId || 'unknown'
                        },
                        payload: {
                            type: 'INTERNAL_ERROR',
                            message: `Internal server error: ${err.message}`
                        }
                    }
                });
            }
        });

        let server;
        try {
            server = app.listen(port, () => {
                node.log(`Alexa IOT Hub listening on port ${port}`);
                node.status({ fill: 'green', shape: 'dot', text: `listening on ${port}` });
            });
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
