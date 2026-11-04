import type { Page } from '@playwright/test';

// Exercise the same disclosures a person uses; never bypass hidden controls.
export async function expandComposer(page: Page, section: 'attachments' | 'advanced') {
  const selector = section === 'attachments' ? 'Attachments' : 'References & change details';
  const groups = page.locator('.composer > details.composer-options').filter({
    has: page.locator('summary').filter({ hasText: selector }),
  });
  await groups.first().waitFor({ state: 'attached' });
  for (const group of await groups.all()) {
    if ((await group.getAttribute('open')) === null)
      await group.locator(':scope > summary').click();
  }
}
