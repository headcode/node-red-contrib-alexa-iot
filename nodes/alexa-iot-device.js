'use strict';

module.exports = function(RED) {
    // Ensure RED is defined
    if (!RED || !RED.nodes || !RED.nodes.registerType) {
        console.error('Node-RED runtime (RED) is undefined. Cannot register alexa-iot-device node.');
        return;
    }

    function AlexaIOTDeviceNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const { name, hub, targetNode, topic } = config;

        // Store custom topic and name
        node.topic = topic;
        node.name = name;
        node.hubId = hub;

        // Function to validate hub and update status
        function validateHub() {
            if (!node.hubId) {
                node.error(`Missing hub configuration. Hub ID: ${node.hubId}`);
                node.status({ fill: 'red', shape: 'ring', text: 'missing hub config' });
                return false;
            }

            const hubNode = RED.nodes.getNode(node.hubId);
            if (!hubNode) {
                node.error(`Hub node not found for ID: ${node.hubId}. Ensure the Alexa IOT Hub node is deployed.`);
                node.status({ fill: 'red', shape: 'ring', text: `no hub: ${node.hubId}` });
                return false;
            }
            if (hubNode.type !== 'alexa-iot-hub') {
                node.error(`Invalid hub type for ID ${node.hubId}: expected alexa-iot-hub, got ${hubNode.type}`);
                node.status({ fill: 'red', shape: 'ring', text: `invalid hub: ${hubNode.type}` });
                return false;
            }

            node.status({ fill: 'green', shape: 'dot', text: 'linked to hub' });
            return true;
        }

        // Validate hub on initialization
        if (!name) {
            node.error(`Missing name configuration. Name: ${name}`);
            node.status({ fill: 'red', shape: 'ring', text: 'missing name' });
            return;
        }
        validateHub();

        node.on('input', (msg, send, done) => {
            try {
                // Revalidate hub on each input
                if (!validateHub()) {
                    done();
                    return;
                }

                const { payload, topic: inputTopic } = msg;
                let output = { topic: inputTopic, payload: msg.payload };

                // Process payload based on incoming msg.topic
                if (inputTopic === 'power') {
                    const state = payload === true || payload === 'ON' ? 'ON' : 'OFF';
                    RED.util.setMessageProperty(output, 'payload', state, true);
                } else if (inputTopic === 'brightness') {
                    const brightness = Math.max(0, Math.min(100, Number(payload)));
                    RED.util.setMessageProperty(output, 'payload', brightness, true);
                } else if (inputTopic === 'color') {
                    RED.util.setMessageProperty(output, 'payload', payload, true);
                } else if (!node.topic) {
                    node.warn(`Unsupported topic: ${inputTopic}`);
                    done();
                    return;
                }

                // Override output topic with custom topic if set
                output.topic = node.topic || inputTopic;

                // Add device name to output message
                output.device = node.name;

                // Update node status with trigger timestamp
                node.status({ fill: 'green', shape: 'dot', text: new Date().toLocaleString() });

                if (node.topic) {
                    node.debug(`Using custom topic: ${node.topic}`);
                }

                send(output);

                // Forward to target node if conditions met
                if (output && output.payload !== null && targetNode) {
                    const target = RED.nodes.getNode(targetNode);
                    if (target) {
                        target.receive(output);
                        node.debug(`Forwarded message to target node: ${target.name || target.id}`);
                    } else {
                        node.warn(`Target node not found: ${targetNode}`);
                    }
                }

                done();
            } catch (err) {
                node.error(`Error processing input: ${err.message}`, msg);
                node.status({ fill: 'red', shape: 'ring', text: `error: ${err.message}` });
                done(err);
            }
        });

        node.on('close', () => {
            node.status({});
        });
    }

    try {
        RED.nodes.registerType('alexa-iot-device', AlexaIOTDeviceNode);
    } catch (err) {
        console.error(`Failed to register alexa-iot-device node: ${err.message}`);
    }
};
