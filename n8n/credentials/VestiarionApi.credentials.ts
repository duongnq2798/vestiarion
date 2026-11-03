import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * A workspace API key, sent as a bearer token to the workspace's API. The signing secret is the one a webhook endpoint
 * shows once, in Settings, and is used by the Vestiarion Trigger alone: it is never sent anywhere.
 */
export class VestiarionApi implements ICredentialType {
	name = 'vestiarionApi';

	displayName = 'Vestiarion API';

	icon: Icon = { light: 'file:../icons/vestiarion.svg', dark: 'file:../icons/vestiarion.dark.svg' };

	documentationUrl = 'https://www.vestiarion.xyz/docs/get-started/n8n#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			placeholder: 'vxk_...',
			description:
				'A workspace API key. An owner or an admin creates one on the workspace\'s Settings page, under API keys. Adding bills needs one that can also add records.',
		},
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://www.vestiarion.xyz',
			required: true,
			description: 'The API\'s origin, over https. Change it only for your own deployment; plain http works only for localhost.',
		},
		{
			displayName: 'Webhook Signing Secret',
			name: 'webhookSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			placeholder: 'whsec_...',
			description:
				'For the Vestiarion Trigger only: the signing secret Settings shows once when you add the webhook endpoint, whsec_ included. Leave it empty for the Vestiarion node.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '/api/v1/status',
			method: 'GET',
		},
	};
}
