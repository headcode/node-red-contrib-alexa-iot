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
        const { name, hub, targetNode, topic } = config; // Added topic

        // Validate configuration
        if (!name || !hub) {
            node.error(`Missing name or hub configuration. Name: ${name}, Hub ID: ${hub}`);
            node.status({ fill: 'red', shape: 'ring', text: 'missing config' });
            return;
        }

        const hubNode = RED.nodes.getNode(hub);
        if (!hubNode) {
            node.error(`Hub node not found for ID: ${hub}. Ensure the Alexa IOT Hub node is deployed and correctly configured.`);
            node.status({ fill: 'red', shape: 'ring', text: `no hub: ${hub}` });
            return;
        }
        if (hubNode.type !== 'alexa-iot-hub') {
            node.error(`Invalid hub type for ID ${hub}: expected alexa-iot-hub, got ${hubNode.type}`);
            node.status({ fill: 'red', shape: 'ring', text: `invalid hub: ${hubNode.type}` });
            return;
        }

        // Store custom topic
        node.topic = topic;

        // Set initial status
        node.status({ fill: 'green', shape: 'dot', text: 'connected to hub' });

        node.on('input', (msg, send, done) => {
            try {
                const { payload } = msg;
                // Use custom topic if defined, else fall back to incoming msg.topic
                const outputTopic = node.topic || msg.topic;
                let output = { topic: outputTopic, payload: msg.payload };

                if (outputTopic === 'power' || (!node.topic && msg.topic === 'power')) {
                    const state = payload === true || payload === 'ON' ? 'ON' : 'OFF';
                    RED.util.setMessageProperty(output, 'payload', state, true);
                } else if (outputTopic === 'brightness' || (!node.topic && msg.topic === 'brightness')) {
                    const brightness = Math.max(0, Math.min(100, Number(payload)));
                    RED.util.setMessageProperty(output, 'payload', brightness, true);
                } else if (outputTopic === 'color' || (!node.topic && msg.topic === 'color')) {
                    RED.util.setMessageProperty(output, 'payload', payload, true);
                } else {
                    node.warn(`Unsupported topic: ${outputTopic}`);
                    done();
                    return;
                }

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
