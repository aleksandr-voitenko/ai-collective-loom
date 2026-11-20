import { defineConfig } from '@playwright/test';
import { join } from 'node:path';
import browserConfig from '../../playwright.config.js';

const privateOutput = process.env.LOOM_TOPIC_LAYOUT_PRIVATE_OUTPUT;
if (!privateOutput) throw new Error('Run the topic layout review with run-topic-layout.mjs.');

export default defineConfig({
  ...browserConfig,
  testDir: '.',
  quiet: true,
  preserveOutput: 'never',
  reporter: [['json', { outputFile: join(privateOutput, 'result.json') }]],
  outputDir: join(privateOutput, 'playwright'),
});
