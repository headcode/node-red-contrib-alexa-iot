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

        // SSDP Configuration
        const ssdp = new SSDPServer({
            location: `http://${require('ip').address()}:${port}/alexa`,
            udn: `uuid:${node.id}`,
            sourcePort: 1900,
            adInterval: 10000
        });

        ssdp.addUSN('upnp:rootdevice');
        ssdp.addUSN('urn:schemas-upnp-org:device:SmartHomeHub:1');

        ssdp.on('advertise-alive', (headers) => {
            node.debug('SSDP advertise-alive: ' + JSON.stringify(headers));
        });

        ssdp.on('advertise-bye', (headers) => {
            node.debug('SSDP advertise-bye: ' + JSON.stringify(headers));
        });

        // Start SSDP server
        try {
            ssdp.start();
            node.log(`SSDP server started, advertising on http://${require('ip').address()}:${port}/alexa`);
        } catch (err) {
            node.error(`Failed to start SSDP server: ${err.message}`);
        }

        // Log all incoming requests
        app.use('/alexa', (req, res, next) => {
            node.log(`Request from ${req.ip}: ${req.method} ${req.url}`);
            next();
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
                    RED.nodes.eachNode(n => {
                        if (n.type === 'alexa-iot-device' && RED.nodes.getNode(n.hub) === node) {
                            devices.push({
                                endpointId: n.endpointId || n.id,
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
