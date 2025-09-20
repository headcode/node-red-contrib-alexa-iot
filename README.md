Node-Red Amazon Alexa Integration to Create, Discover, and Trigger local device nodes.

Overview of the Project

The node-red-contrib-alexa-iot module integrates Amazon Echo (Alexa) voice control with Node-RED, enabling local control of devices without requiring Alexa Skills or cloud dependencies. It leverages the node-red-contrib-alexa-smart-home package to handle Alexa Smart Home protocol interactions.

The module includes two Node-RED nodes:

Alexa IOT Hub Node: Acts as a server that communicates with Amazon Alexa, handling device discovery and directives (e.g., turn on/off, set brightness, set color). It forwards these directives as messages to the appropriate device nodes.

Alexa IOT Device Node: Represents individual devices in a Node-RED flow, each with a unique name and ID, allowing Alexa to control them via the hub node. These nodes process incoming messages (e.g., power, brightness, color) and can forward them to other targeted nodes or output them directly.
