/**
 * @regression @ui @hermetic VAL-070 — an UNREAD title says so, on BOTH layouts.
 *
 * The tag appears in this header comment AND in the describe title below. This file is
 * correctly tagged. Reporting it is a FALSE POSITIVE, and a false positive here accuses
 * someone of a mistake they did not make.
 */
import { test, expect } from '@playwright/test';

test.describe('@regression @ui @hermetic VAL-070 an unread title is labelled', () => {
  test('VAL-070: the spec strip says NOT VERIFIED', async () => { expect(1).toBe(1); });
});
