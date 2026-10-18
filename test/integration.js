'use strict';
const path = require('node:path');
const assert = require('node:assert/strict');
const { tests } = require('@iobroker/testing');

tests.integration(path.join(__dirname, '..'), {
    controllerVersion: process.env.CONTROLLER_VERSION || '7.2.5',
    defineAdditionalTests({ suite }) {
        suite('Legacy credentials migrate through the real adapter encryption API', getHarness => {
            it('stores AES-encrypted credentials and preserves settings without contacting EcoFlow', async function () {
                this.timeout(30000);
                const h = getHarness();
                const id = 'system.adapter.ecoflow-powercontrol.0';
                const obj = await h.objects.getObjectAsync(id);
                obj.native.ecoflow.enabled = false;
                obj.native.ecoflow.password = 'SYNTHETIC_MIGRATION_SECRET';
                obj.native.regMinValueMin = 0;
                await h.objects.setObjectAsync(id, obj);
                await h.startAdapterAndWait(false);
                const deadline = Date.now() + 10000;
                let saved;
                do {
                    saved = await h.objects.getObjectAsync(id);
                    if (saved.native.efPassword?.startsWith('$/aes-192-cbc:')) break;
                    if (Date.now() > deadline) throw new Error('Credential migration did not finish');
                    await new Promise(resolve => setTimeout(resolve, 50));
                } while (true);
                assert.equal(saved.native.ecoflow.password, undefined);
                assert.equal(saved.native.regulation.minValueMin, 0);
                assert.equal(saved.native.ecoflow.enabled, false);
                const system = await h.objects.getObjectAsync('system.config');
                const [, iv, ciphertext] = saved.native.efPassword.split(':');
                const decipher = require('node:crypto').createDecipheriv('aes-192-cbc',
                    Buffer.from(system.native.secret, 'hex'), Buffer.from(iv, 'hex'));
                const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'hex')), decipher.final()]).toString();
                assert.equal(plain, 'SYNTHETIC_MIGRATION_SECRET');
                await h.stopAdapter();
            });
        });
        suite('Isolated regulation with real Objects/States DB', getHarness => {
            it('starts, regulates a synthetic inverter, respects manual off and shuts down', async function () {
                this.timeout(90000);
                const h = getHarness();
                const namespace = 'ecoflow-powercontrol.0';
                const instanceId = `system.adapter.${namespace}`;
                const obj = await h.objects.getObjectAsync(instanceId);
                obj.native.regulation = { ...obj.native.regulation, smartmeterStateId: '0_userdata.0.review.meter',
                    minValueMin: 0, intervalSec: 1, basePowerOffset: 0 };
                obj.native.ecoflow.enabled = false;
                obj.native.inverters = [{ id: 'SYNTHETIC', type: 'generic', regulation: true, maxPower: 800, hasBat: true,
                    outputStateId: '0_userdata.0.review.output', setOutputStateId: '0_userdata.0.review.target',
                    batterySOCStateId: '0_userdata.0.review.soc', pvPowerStateId: '0_userdata.0.review.pv',
                    battPozOn: 95, battPozOff: 90, lowBatLimitPozOn: 10, lowBatLimitPozOff: 20, lowBatLimit: 100, regulationOffPower: 0 }];
                await h.objects.setObjectAsync(instanceId, obj);
                for (const [name, value] of Object.entries({ meter: 100, output: 0, target: 0, soc: 50, pv: 0 })) {
                    const id = `0_userdata.0.review.${name}`;
                    await h.objects.setObjectAsync(id, { type: 'state', common: { name, type: 'number', role: 'value', read: true, write: true }, native: {} });
                    await h.states.setStateAsync(id, { val: value, ack: true });
                }
                await h.startAdapterAndWait(false);
                const wait = async predicate => {
                    const deadline = Date.now() + 20000;
                    while (!(await predicate())) {
                        if (Date.now() > deadline) throw new Error('Timed out waiting for isolated adapter behavior');
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                };
                const target = '0_userdata.0.review.target';
                await wait(async () => (await h.states.getStateAsync(target))?.val > 0);
                assert.ok((await h.states.getStateAsync(target)).val <= 100, '100W demand must never become 1000W');
                await h.states.setStateAsync(`${namespace}.regulation.enabled`, { val: false, ack: false });
                await wait(async () => (await h.states.getStateAsync(target))?.val === 0);
                await new Promise(resolve => setTimeout(resolve, 2200));
                assert.equal((await h.states.getStateAsync(target)).val, 0);
                assert.equal((await h.states.getStateAsync(`${namespace}.info.connection`)).val, false);
                await h.stopAdapter(); assert.equal(h.isAdapterRunning(), false);
            });
        });
    },
});
