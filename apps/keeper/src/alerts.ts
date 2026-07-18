/**
 * Alert sinks (OPERATIONS.md §3). The PoC ships a console sink plus a generic webhook
 * stub; a real pager integration is a deployment concern, not a code change — every
 * alert flows through `raise()`.
 */
export type AlertKind =
  | "no-vote-late-epoch"
  | "tx-failed"
  | "target-stale"
  | "rpc-failure"
  | "strategy-ref-mismatch"
  | "diamond-cut-observed";

export interface Alert {
  kind: AlertKind;
  message: string;
  at: string;
}

export async function raise(kind: AlertKind, message: string): Promise<void> {
  const alert: Alert = { kind, message, at: new Date().toISOString() };
  // console sink — always on
  console.error(`[ALERT:${alert.kind}] ${alert.message}`);
  // webhook sink — optional (e.g. Slack-compatible); failures must never crash the keeper
  const url = process.env.ALERT_WEBHOOK_URL;
  if (url) {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `[${alert.kind}] ${alert.message}`, ...alert }),
      });
    } catch (err) {
      console.error(`[ALERT-SINK-FAILED] ${String(err)}`);
    }
  }
}
