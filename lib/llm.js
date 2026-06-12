/**
 * Shared Anthropic client for the Vantage Platform.
 *
 * Import in any app's api.js:
 *
 *   const { claude } = require('../../lib/llm');
 *
 * Reads ANTHROPIC_API_KEY from the environment automatically.
 * One instance is created at server startup and reused by all apps —
 * no need to instantiate your own client.
 *
 * Prerequisite: set ANTHROPIC_API_KEY in Azure App Service →
 *   Configuration → Application Settings.
 */

const Anthropic = require('@anthropic-ai/sdk');

const claude = new Anthropic();

module.exports = { claude };
