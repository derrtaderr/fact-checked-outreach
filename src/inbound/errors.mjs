// One error shape for every HubSpot and Slack failure. docs/INBOUND-SPEC.md, "Adapters".
//
// `code` is the reason the engine records and prints. `ambiguous` is the one bit the crash story
// depends on: true means the call may have taken effect (a timeout or a dropped connection after the
// request left), so the engine must not treat it as "nothing happened" and do it again blindly.

export class InboundAdapterError extends Error {
  constructor(code, message, { ambiguous = false } = {}) {
    super(message);
    this.name = 'InboundAdapterError';
    this.code = code;
    this.ambiguous = ambiguous;
  }
}
