'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const sanitizeHtml = require('sanitize-html');

module.exports = function(RED) {
    if (!RED || !RED.nodes || !RED.nodes.registerType) {
        console.error('Node-RED runtime (RED) is undefined. Cannot register alexa-iot-hub node.');
        return;
    }

    function AlexaIOTHubNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const { port = 80, debug = false } = config;

        try {
            const app = express();
            app.use(helmet());
            app.use(rateLimit({
                windowMs: 15 * 60 * 1000,
                max: 100,
                message: 'Too many requests, please try again later.'
            }));
            app.use(express.json());

            // Log all incoming requests for debugging
            app.use('/alexa', (req, res, next) => {
                node.log(`Incoming request to /alexa from IP ${req.ip}: Method=${req.method}, Body=${JSON.stringify(req.body, null, 2)}`);
                next();
            });

            // Custom Alexa endpoint for Echo device discovery and control
            app.post('/alexa', async (req, res) => {
                if (debug) {
                    node.log(`Request from ${req.ip}: ${req.method} ${req.url} Headers: ${JSON.stringify(req.headers)}`);
              //      node.log(`Processing Alexa request from IP ${req.ip}: ${JSON.stringify(req.body, null, 2)}`);
                }

                const { directive } = req.body;
                if (!directive) {
                    const errorResponse = {
                        event: {
                            header: {
                                namespace: 'Alexa',
                                name: 'ErrorResponse',
                                payloadVersion: '3',
                                messageId: req.body.directive?.header?.messageId || 'unknown'
                            },
                            payload: {
                                type: 'INVALID_DIRECTIVE',
                                message: 'Missing or invalid directive'
                            }
                        }
                    };
                    if (debug) {
                        node.log(`Error response: ${JSON.stringify(errorResponse, null, 2)}`);
                    }
                    return res.status(400).json(errorResponse);
                }

                const { header, endpoint, payload } = directive;
                const { namespace, name, messageId, correlationToken } = header;
                const endpointId = endpoint ? endpoint.endpointId : null;

                // Handle Discovery
                if (namespace === 'Alexa.Discovery' && name === 'Discover') {
                    const devices = await getDevices(RED);
                    const response = {
                        event: {
                            header: {
                                namespace: 'Alexa.Discovery',
                                name: 'Discover.Response',
                                payloadVersion: '3',
                                messageId: messageId
                            },
                            payload: {
                                endpoints: devices.map(device => ({
                                    endpointId: device.id,
                                    friendlyName: sanitizeHtml(device.name, { allowedTags: [] }),
                                    description: `Node-RED ${device.name}`,
                                    manufacturerName: 'Node-RED',
                                    displayCategories: ['LIGHT', 'SWITCH'],
                                    capabilities: [
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
                                }))
                            }
                        }
                    };
                    if (debug) {
                        node.log(`Discovery response: ${JSON.stringify(response, null, 2)}`);
                    }
                    return res.json(response);
                }

                // Handle Control Directives
                if (!endpointId) {
                    const errorResponse = {
                        event: {
                            header: {
                                namespace: 'Alexa',
                                name: 'ErrorResponse',
                                payloadVersion: '3',
                                messageId: messageId,
                                correlationToken
                            },
                            payload: {
                                type: 'ENDPOINT_UNREACHABLE',
                                message: `Device ${endpointId} not found`
                            }
                        }
                    };
                    if (debug) {
                        node.log(`Error response: ${JSON.stringify(errorResponse, null, 2)}`);
                    }
                    return res.status(400).json(errorResponse);
                }

                const deviceNode = RED.nodes.getNode(endpointId);
                if (!deviceNode) {
                    const errorResponse = {
                        event: {
                            header: {
                                namespace: 'Alexa',
                                name: 'ErrorResponse',
                                payloadVersion: '3',
                                messageId: messageId,
                                correlationToken
                            },
                            payload: {
                                type: 'ENDPOINT_UNREACHABLE',
                                message: `Device ${endpointId} not found`
                            }
                        }
                    };
                    if (debug) {
                        node.log(`Error response: ${JSON.stringify(errorResponse, null, 2)}`);
                    }
                    return res.status(404).json(errorResponse);
                }

                const msg = { topic: '', payload: null };
                let responseProperty = null;

                if (namespace === 'Alexa.PowerController' && name === 'TurnOn') {
                    msg.topic = 'power';
                    msg.payload = 'ON';
                    responseProperty = { namespace: 'Alexa.PowerController', name: 'powerState', value: 'ON' };
                } else if (namespace === 'Alexa.PowerController' && name === 'TurnOff') {
                    msg.topic = 'power';
                    msg.payload = 'OFF';
                    responseProperty = { namespace: 'Alexa.PowerController', name: 'powerState', value: 'OFF' };
                } else if (namespace === 'Alexa.BrightnessController' && name === 'SetBrightness') {
                    msg.topic = 'brightness';
                    msg.payload = payload.brightness;
                    responseProperty = { namespace: 'Alexa.BrightnessController', name: 'brightness', value: payload.brightness };
                } else if (namespace === 'Alexa.ColorController' && name === 'SetColor') {
                    msg.topic = 'color';
                    msg.payload = payload.color;
                    responseProperty = { namespace: 'Alexa.ColorController', name: 'color', value: payload.color };
                } else {
                    const errorResponse = {
                        event: {
                            header: {
                                namespace: 'Alexa',
                                name: 'ErrorResponse',
                                payloadVersion: '3',
                                messageId: messageId,
                                correlationToken
                            },
                            payload: {
                                type: 'INVALID_DIRECTIVE',
                                message: `Unsupported directive: ${namespace}.${name}`
                            }
                        }
                    };
                    if (debug) {
                        node.log(`Error response: ${JSON.stringify(errorResponse, null, 2)}`);
                    }
                    return res.status(400).json(errorResponse);
                }

                deviceNode.receive(msg);

                // Send Response
                const response = {
                    event: {
                        header: {
                            namespace: 'Alexa',
                            name: 'Response',
                            payloadVersion: '3',
                            messageId: messageId,
                            correlationToken
                        },
                        endpoint: { endpointId },
                        payload: {}
                    },
                    context: {
                        properties: [
                            {
                                namespace: responseProperty.namespace,
                                name: responseProperty.name,
                                value: responseProperty.value,
                                timeOfSample: new Date().toISOString(),
                                uncertaintyInMilliseconds: 0
                            }
                        ]
                    }
                };
                if (debug) {
                    node.log(`Directive response: ${JSON.stringify(response, null, 2)}`);
                }
                res.json(response);
            });

            async function getDevices(red) {
                const devices = [];
                red.nodes.eachNode(n => {
                    if (n.type === 'alexa-iot-device' && n.hub === node.id) {
                        devices.push({ id: n.id, name: n.name });
                    }
                });
                return devices;
            }

            const server = app.listen(port, () => {
                node.log(`Alexa IOT Hub listening on port ${port}`);
                node.status({ fill: 'green', shape: 'dot', text: `Listening on port ${port}` });
            });

            node.on('close', async (done) => {
                await new Promise(resolve => server.close(resolve));
                node.log('Alexa IOT Hub closed');
                node.status({});
                done();
            });
        } catch (err) {
            node.error(`Failed to initialize Alexa IOT Hub: ${err.message}`);
            node.status({ fill: 'red', shape: 'ring', text: `error: ${err.message}` });
        }
    }

    try {
        RED.nodes.registerType('alexa-iot-hub', AlexaIOTHubNode);
    } catch (err) {
        console.error(`Failed to register alexa-iot-hub node: ${err.message}`);
    }
};

