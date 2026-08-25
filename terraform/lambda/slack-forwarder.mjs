// SNS -> Slack, the whole alerting fan-out (MILESTONE-6-PLAN.md 8: one Slack
// webhook, critical alerts only, no paging hierarchy for an audience of one).
//
// The webhook URL is a credential, so it lives in Secrets Manager
// (pipeline-radar/slack-webhook, created by hand like the Anthropic key) and
// is fetched at runtime. Absent secret = alerts log and drop rather than
// fail: alerting must degrade, never take an alarm evaluation down with it.

import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({});
let cachedUrl = null;

async function webhookUrl() {
  if (cachedUrl) return cachedUrl;
  const out = await client.send(
    new GetSecretValueCommand({ SecretId: process.env.WEBHOOK_SECRET_NAME }),
  );
  cachedUrl = out.SecretString?.trim();
  return cachedUrl;
}

function describe(message) {
  try {
    const alarm = JSON.parse(message);
    const state = alarm.NewStateValue === 'ALARM' ? ':red_circle:' : ':large_green_circle:';
    return `${state} *${alarm.AlarmName}* is ${alarm.NewStateValue}\n${alarm.NewStateReason ?? ''}`;
  } catch {
    return message; // not an alarm envelope - forward as-is
  }
}

export async function handler(event) {
  let url;
  try {
    url = await webhookUrl();
  } catch (err) {
    console.error(JSON.stringify({ evt: 'alerts.no_webhook', err: String(err) }));
    return;
  }
  if (!url) return;

  for (const record of event.Records ?? []) {
    const text = describe(record.Sns?.Message ?? '');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      console.error(JSON.stringify({ evt: 'alerts.slack_error', status: res.status }));
    }
  }
}
