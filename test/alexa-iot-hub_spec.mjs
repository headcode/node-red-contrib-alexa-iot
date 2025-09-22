'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const RED = require('node-red');

describe('Alexa IOT Hub Node', () => {
    let node, REDMock;

    beforeEach(() => {
        REDMock = {
            nodes: {
                createNode: sinon.spy(),
                registerType: sinon.spy(),
                getNode: sinon.stub().returns({ id: 'device1', name: 'TestDevice', type: 'alexa-iot-device', hub: 'hub1' }),
                eachNode: sinon.stub().callsArgWith(0, [
                    { id: 'device1', name: 'TestDevice', type: 'alexa-iot-device', hub: 'hub1' }
                ])
            },
            log: sinon.spy(),
            util: {
                evaluateNodeProperty: sinon.stub().returns({ port: 80, debug: false })
            }
        };
        require('../nodes/alexa-iot-hub')(REDMock);
        node = REDMock.nodes.registerType.args[0][1];
    });

    it('should register the node', () => {
        expect(REDMock.nodes.registerType.calledWith('alexa-iot-hub')).to.be.true;
    });

    it('should initialize with default port', () => {
        const instance = new node({ id: 'hub1', port: '80' });
        expect(REDMock.nodes.createNode.called).to.be.true;
        expect(REDMock.util.evaluateNodeProperty.calledWith({ id: 'hub1', port: '80' }, 'config')).to.be.true;
    });

    it('should close server on node close', (done) => {
        const instance = new node({ id: 'hub1', port: '80' });
        instance.on('close', () => {
            expect(REDMock.log.calledWith('Alexa IOT Hub closed')).to.be.true;
            done();
        });
        instance.emit('close', done);
    });

});
