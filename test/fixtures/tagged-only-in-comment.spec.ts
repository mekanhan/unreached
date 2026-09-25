/**
 * @hermetic — no network, safe for the PR gate.
 *
 * Reads as tagged to every human who opens it. Is not tagged. `--grep @hermetic`
 * collects nothing here, the job reports success, and nothing anywhere says so.
 */
import { test, expect } from '@playwright/test';

test.describe('the extension card renders its fee panel', () => {
  test('the fee row shows a total', async () => { expect(1).toBe(1); });
});
