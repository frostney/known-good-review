import { defineState } from "eve/context";
import {
  enqueuePendingGatewayTelemetry,
  type PendingGatewayTelemetry,
} from "../../src/telemetry/gateway-reconciliation";

export const pendingGatewayTelemetry = defineState<
  readonly PendingGatewayTelemetry[]
>("known-good-review.gateway-telemetry.v1", () => []);

export function enqueueGatewayTelemetry(
  observation: PendingGatewayTelemetry,
): void {
  pendingGatewayTelemetry.update((current) =>
    enqueuePendingGatewayTelemetry(current, observation),
  );
}
