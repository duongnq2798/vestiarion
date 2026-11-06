'use strict';

const { vestiarion } = require('./lib/http');

/**
 * The connection: a workspace API key and, for your own deployment, a Base URL (Zapier Z3). The test reads the
 * workspace's status, and the connection is labelled with its name.
 */
module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'apiKey',
      label: 'API Key',
      type: 'password',
      required: true,
      helpText:
        'A workspace API key, from Settings, then API keys, in Vestiarion ([how](https://www.vestiarion.xyz/docs/get-started/authentication)). Tick **Can also add records** when you create it if a Zap will add bills.',
    },
    {
      key: 'baseUrl',
      label: 'Base URL',
      type: 'string',
      required: false,
      default: 'https://www.vestiarion.xyz',
      helpText: 'Leave it as it is unless you run Vestiarion yourself ([the Zapier guide](https://www.vestiarion.xyz/docs/get-started/zapier)). It must start with https.',
    },
  ],
  test: (z, bundle) => vestiarion(z, bundle, { path: '/api/v1/status' }),
  // The test's answer is `{ data: { businessName, ... } }`.
  connectionLabel: (z, bundle) => (bundle.inputData && bundle.inputData.data && bundle.inputData.data.businessName) || 'Vestiarion workspace',
};
