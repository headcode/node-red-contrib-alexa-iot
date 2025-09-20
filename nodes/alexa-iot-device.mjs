export default function(RED) {
    function AlexaIOTDeviceNode(config) {
        RED.nodes.createNode(this, config);
        const node = this;
        const { name, hub, targetNode } = config;

        if (!name || !hub) {
            node.error('Missing name or hub configuration');
            return;
        }

        const hubNode = RED.nodes.getNode(hub);
        if (!hubNode) {
            node.error('Hub node not found');
            return;
        }

        node.on('input', (msg, send, done) => {
            try {
                const { payload, topic } = msg;
                let output = { ...msg };

                if (topic === 'power') {
                    const state = payload === true || payload === 'ON' ? 'ON' : 'OFF';
                    RED.util.setMessageProperty(output, 'payload', state, true);
                } else if (topic === 'brightness') {
                    const brightness = Math.max(0, Math.min(100, Number(payload)));
                    RED.util.setMessageProperty(output, 'payload', brightness, true);
                } else if (topic === 'color') {
                    RED.util.setMessageProperty(output, 'payload', payload, true);
                } else {
                    node.warn(`Unsupported topic: ${topic}`);
                    done();
                    return;
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
                done(err);
            }
        });
    }
    RED.nodes.registerType('alexa-iot-device', AlexaIOTDeviceNode);

};
