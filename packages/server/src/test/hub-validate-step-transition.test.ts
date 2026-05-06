import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

// Regression test for the hub items_closed rollup.
//
// The hub aggregates closed-item counts via:
//   SUM(CASE WHEN type = 'step.transitioned'
//             AND json_extract(payload, '$.payload.toStatus') = 'DONE'
//             THEN 1 ELSE 0 END)
// (packages/hub/src/rollup.ts)
//
// Items reach DONE through validate_progress, which calls storage.updateItem
// directly (bypassing PUT /items/:id). Before this fix, that path emitted only
// `validate.passed` — never `step.transitioned` — so items_closed was always 0
// in rollups_daily even when items were properly closed.
//
// This test pins the contract: the validate-passed branch must emit a
// step.transitioned event whose payload contains toStatus, alongside the
// validate.passed event.

const serverSource = readFileSync(
    path.resolve(__dirname, '../server.ts'),
    'utf8'
);

describe('validate_progress emits step.transitioned for hub rollups', () => {
    it('source contains a step.transitioned recordHubEvent call near validate.passed', () => {
        const passedIdx = serverSource.indexOf("type: 'validate.passed'");
        expect(passedIdx).toBeGreaterThan(-1);

        // Look in a small window around the validate.passed emission for a
        // sibling step.transitioned emission. Window covers a few hundred lines
        // before/after to allow for refactors that move the emission slightly.
        const windowStart = Math.max(0, passedIdx - 4000);
        const windowEnd = Math.min(serverSource.length, passedIdx + 4000);
        const window = serverSource.slice(windowStart, windowEnd);
        expect(window).toMatch(/type:\s*['"]step\.transitioned['"]/);
    });

    it('the emitted step.transitioned payload includes toStatus (so the rollup query matches)', () => {
        // The rollup extracts json_extract(payload, '$.payload.toStatus').
        // If the emitter ever drops toStatus from the payload, items_closed
        // silently regresses to 0 again.
        const allTransitionEmissions = [...serverSource.matchAll(
            /type:\s*['"]step\.transitioned['"][\s\S]{0,300}?payload:\s*\{[^}]*\}/g
        )];
        expect(allTransitionEmissions.length).toBeGreaterThan(0);
        for (const m of allTransitionEmissions) {
            expect(m[0]).toMatch(/toStatus/);
        }
    });

    // item.closed is a first-class hub event distinct from step.transitioned, so
    // hub UI users can filter for closures specifically (the chip filter cannot
    // express "step.transitioned WHERE toStatus=DONE"). It must be emitted at
    // every site that lands an item on DONE.
    it('source emits item.closed at least twice (update_item + validate_progress paths)', () => {
        const matches = [...serverSource.matchAll(/type:\s*['"]item\.closed['"]/g)];
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });
});
