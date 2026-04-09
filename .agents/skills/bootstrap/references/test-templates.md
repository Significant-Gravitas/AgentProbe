# Test Templates

---

## playwright.config.ts

```typescript
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'html' : 'list',
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  outputDir: process.env.ARTIFACTS_DIR || 'test-results',
});
```

---

## e2e/smoke.behavior.spec.ts

Adapt the selectors and URLs to the actual project. The important things are:
- Tag with `@smoke` so the suite can be filtered
- Test real user journeys, not implementation details
- Keep it small — 3 tests max for the initial suite

```typescript
import { test, expect } from '@playwright/test';

test.describe('@smoke Core smoke tests', () => {
  test('login page renders', async ({ page }) => {
    await page.goto('/login');
    // Adapt selector to your actual login page
    await expect(page.locator('form')).toBeVisible();
    await expect(page).toHaveTitle(/{{project_name}}/i);
  });

  test('authenticated user reaches dashboard', async ({ page }) => {
    // Adapt authentication to your setup.
    // Options: test user credentials, auth state fixture, or API login.
    //
    // Example with direct login:
    // await page.goto('/login');
    // await page.fill('[name="email"]', 'test@example.com');
    // await page.fill('[name="password"]', 'testpassword');
    // await page.click('button[type="submit"]');
    //
    // Example with stored auth state:
    // test.use({ storageState: 'e2e/.auth/user.json' });

    await page.goto('/');
    // Adapt: check for a dashboard-specific element
    // await expect(page.locator('[data-testid="dashboard"]')).toBeVisible();
  });

  test('core listing page renders', async ({ page }) => {
    // Navigate to the main work queue / listing page
    // await page.goto('/{{main_listing_path}}');
    // await expect(page.locator('[data-testid="listing"]')).toBeVisible();
  });
});
```

---

## Notes on test setup

- Install Playwright as a dev dependency: `npm install -D @playwright/test`
- Install browsers: `npx playwright install chromium`
- For CI, use `npx playwright install --with-deps chromium`
- Store test auth state in `e2e/.auth/` and add it to `.gitignore`
- The `@smoke` tag lets you run just the smoke suite: `npx playwright test --grep @smoke`
