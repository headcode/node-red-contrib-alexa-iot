'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const AlexaSmartHome = require('node-red-contrib-alexa-smart-home');
const sanitizeHtml = require('sanitize-html');

module.exports = function(RED) {
    function AlexaIOTHubNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const { port = 80, debug = false } = RED.util.evaluateNodeProperty(config, 'config');

        const app = express();
        app.use(helmet());
        app.use(rateLimit({
            windowMs: 15 * 60 * 1000,
            max: 100,
            message: 'Too many requests, please try again later.'
        }));

        const alexa = new AlexaSmartHome({
            debug: debug === 'true',
            discoveryCallback: async (req) => {
                const devices = await getDevices(RED);
                return {
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
                };
            },
            directiveCallback: async (directive, sendResponse) => {
                const { endpointId, namespace, name } = directive;
                const deviceNode = RED.nodes.getNode(endpointId);
                if (!deviceNode) {
                    sendResponse(new Error(`Device ${endpointId} not found`));
                    return;
                }
                const msg = { topic: '', payload: null };
                if (namespace === 'Alexa.PowerController' && name === 'TurnOn') {
                    msg.topic = 'power';
                    msg.payload = 'ON';
                } else if (namespace === 'Alexa.PowerController' && name === 'TurnOff') {
                    msg.topic = 'power';
                    msg.payload = 'OFF';
                } else if (namespace === 'Alexa.BrightnessController' && name === 'SetBrightness') {
                    msg.topic = 'brightness';
                    msg.payload = directive.payload.brightness;
                } else if (namespace === 'Alexa.ColorController' && name === 'SetColor') {
                    msg.topic = 'color';
                    msg.payload = directive.payload.color;
                }
                deviceNode.receive(msg);
                sendResponse(null, { state: msg.payload });
            }
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

        app.use('/alexa', alexa.express());
        const server = app.listen(port, () => {
            node.log(`Alexa IOT Hub listening on port ${port}`);
        });

        node.on('close', async (done) => {
            await new Promise(resolve => server.close(resolve));
            node.log('Alexa IOT Hub closed');
            done();
        });
    }

    RED.nodes.registerType('alexa-iot-hub', AlexaIOTHubNode);
};
