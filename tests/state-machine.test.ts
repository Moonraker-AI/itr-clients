import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import {
  IllegalTransitionError,
  RETREAT_STATES,
  assertTransition,
  canTransition,
  type RetreatState,
} from '../src/lib/state-machine.ts';

describe('state-machine: canTransition', () => {
  test('happy-path forward edges are allowed', () => {
    const happyPath: Array<[RetreatState, RetreatState]> = [
      ['draft', 'awaiting_consents'],
      ['awaiting_consents', 'awaiting_deposit'],
      ['awaiting_deposit', 'scheduled'],
      ['scheduled', 'in_progress'],
      ['in_progress', 'awaiting_final_charge'],
      ['awaiting_final_charge', 'completed'],
      ['awaiting_final_charge', 'final_charge_failed'],
      ['final_charge_failed', 'completed'],
    ];
    for (const [from, to] of happyPath) {
      assert.equal(canTransition(from, to), true, `${from} → ${to} should be allowed`);
    }
  });

  test('cancel edges are allowed from non-terminal states', () => {
    const cancellable: RetreatState[] = [
      'draft',
      'awaiting_consents',
      'awaiting_deposit',
      'scheduled',
    ];
    for (const from of cancellable) {
      assert.equal(canTransition(from, 'cancelled'), true, `cancel from ${from}`);
    }
  });

  test('terminal states cannot be exited', () => {
    for (const to of RETREAT_STATES) {
      if (to === 'completed' || to === 'cancelled') continue;
      assert.equal(canTransition('completed', to), false, `completed → ${to}`);
      assert.equal(canTransition('cancelled', to), false, `cancelled → ${to}`);
    }
  });

  test('skip-ahead jumps are blocked', () => {
    // Cannot skip consents
    assert.equal(canTransition('draft', 'awaiting_deposit'), false);
    // Cannot skip deposit
    assert.equal(canTransition('awaiting_consents', 'scheduled'), false);
    // Cannot leap to completed
    assert.equal(canTransition('scheduled', 'completed'), false);
  });

  test('self-transitions are blocked', () => {
    for (const s of RETREAT_STATES) {
      assert.equal(canTransition(s, s), false, `self-edge ${s}`);
    }
  });
});

describe('state-machine: assertTransition', () => {
  test('throws IllegalTransitionError on bad edge', () => {
    assert.throws(() => assertTransition('draft', 'completed'), IllegalTransitionError);
  });

  test('passes silently on valid edge', () => {
    assert.doesNotThrow(() => assertTransition('draft', 'awaiting_consents'));
  });

  test('error message includes both states', () => {
    try {
      assertTransition('completed', 'in_progress');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof IllegalTransitionError);
      assert.match(err.message, /completed/);
      assert.match(err.message, /in_progress/);
    }
  });
});
