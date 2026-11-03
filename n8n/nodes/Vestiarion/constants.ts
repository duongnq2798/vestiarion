import type { INodePropertyOptions } from 'n8n-workflow';

/** The values the API takes, with the labels n8n shows, sorted by label as n8n's lint asks of written-out lists. */

export const INVOICE_STATUS_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Awaiting Info', value: 'awaiting_info' },
	{ name: 'Flagged', value: 'flagged' },
	{ name: 'Held', value: 'held' },
	{ name: 'Matched', value: 'matched' },
	{ name: 'Paid', value: 'paid' },
	{ name: 'Pending', value: 'pending' },
	{ name: 'Received', value: 'received' },
	{ name: 'Rejected', value: 'rejected' },
	{ name: 'Scheduled', value: 'scheduled' },
];

export const COUNTERPARTY_ROLE_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Client', value: 'client' },
	{ name: 'Contractor', value: 'contractor' },
	{ name: 'Vendor', value: 'vendor' },
];

export const RISK_LEVEL_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Clear', value: 'clear' },
	{ name: 'High', value: 'high' },
	{ name: 'Medium', value: 'medium' },
	{ name: 'Unscreened', value: 'unscreened' },
];

/** The ledger's domains, named for what each holds, with the value the ledger writes. */
export const LEDGER_DOMAIN_OPTIONS: INodePropertyOptions[] = [
	{ name: 'Bills', value: 'ap', description: 'Entries in the ap domain' },
	{ name: 'Contractor Milestones', value: 'contractor', description: 'Entries in the contractor domain' },
	{ name: 'Receivables', value: 'ar', description: 'Entries in the ar domain' },
	{ name: 'Screening and Payees', value: 'compliance', description: 'Entries in the compliance domain' },
	{ name: 'Treasury', value: 'treasury', description: 'Entries in the treasury domain' },
	{ name: 'Workspace', value: 'system', description: 'Entries in the system domain' },
];
