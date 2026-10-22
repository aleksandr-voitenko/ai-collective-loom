import type { Reporter, FullConfig, Suite } from '@playwright/test/reporter';
import { metadata, testIdentity, validPlan, writeChecked } from '../../scripts/lib/browser-diagnostics.mjs';

export default class BrowserInventoryReporter implements Reporter {
  onBegin(_config: FullConfig, suite: Suite) {
    const path = process.env.LOOM_BROWSER_PLAN;
    if (!path) throw new Error('Browser inventory output is required');
    writeChecked(path, { schema: 'loom-browser-plan-1', metadata: metadata(),
      tests: suite.allTests().map(test => testIdentity(test)) }, validPlan);
  }
  // No titles, errors, arbitrary stdout/stderr or reporter attachments leave discovery.
}
