// Event catalogue shared by monitors (producers) and the DecisionMaker
// (consumer). Monitors only describe what they observed; they never decide.

/** Per-container events (ContainerMonitor). */
export type ContainerEventType =
  | "RAM_WARNING" // > RAM_WARNING_PCT of the container's limit
  | "RAM_CRITICAL" // > RAM_CRITICAL_PCT
  | "RAM_EMERGENCY" // > RAM_EMERGENCY_PCT
  | "DISK_WARNING" // > DISK_WARNING_PCT
  | "DISK_CRITICAL" // > DISK_CRITICAL_PCT
  | "DISK_FULL" // > DISK_FULL_PCT
  | "CPU_HIGH"; // > CPU_ALERT_PCT sustained for CPU_ALERT_DURATION

/** Per-node events (ServerMonitor). */
export type ServerEventType =
  | "SERVER_RAM_WARNING" // > SERVER_WARNING_PCT
  | "SERVER_RAM_CRITICAL" // > SERVER_CRITICAL_PCT
  | "SERVER_RAM_EMERGENCY" // > 90%
  | "SERVER_DISK_WARNING"
  | "SERVER_DISK_CRITICAL"
  | "SERVER_FULL" // any resource > 85%
  | "SERVER_OVERLOADED"; // CPU > 90% for 10 minutes

export type EngineEventType = ContainerEventType | ServerEventType;

export type ContainerEventData = {
  vmid: number;
  serviceId: string;
  nodeId: string;
  /** Usage as a percentage of the current limit (0–100+). */
  pct: number;
  used: number;
  limit: number;
  /** Unit of used/limit: "MB" for RAM, "GB" for disk, "%" for CPU. */
  unit: "MB" | "GB" | "%";
  /** CPU_HIGH only: how long usage has stayed above the threshold. */
  sustainedSeconds?: number;
};

export type ServerEventData = {
  nodeId: string;
  nodeName: string;
  pct: number;
  /** Which physical resource crossed the threshold. */
  resource: "RAM" | "DISK" | "CPU";
  sustainedSeconds?: number;
};

type DataFor<T extends EngineEventType> = T extends ContainerEventType ? ContainerEventData : ServerEventData;

export type EngineEvent<T extends EngineEventType = EngineEventType> = {
  [K in T]: {
    /** Unique per published event. */
    id: string;
    type: K;
    /**
     * What the event is about: "service:<serviceId>" for containers (vmids are
     * only unique per node and change on migration) or "node:<name>". Used for
     * de-duplication and action locks.
     */
    subject: string;
    /** Which monitor produced it. */
    source: string;
    /** Epoch milliseconds. */
    at: number;
    data: DataFor<K>;
  };
}[T];

/** What a producer passes to publish(); the bus fills in id and at. */
export type EventInput<T extends EngineEventType = EngineEventType> = {
  [K in T]: { type: K; subject: string; source: string; data: DataFor<K> };
}[T];

const CONTAINER_TYPES = new Set<string>([
  "RAM_WARNING",
  "RAM_CRITICAL",
  "RAM_EMERGENCY",
  "DISK_WARNING",
  "DISK_CRITICAL",
  "DISK_FULL",
  "CPU_HIGH",
]);

export function isContainerEvent(e: EngineEvent): e is EngineEvent<ContainerEventType> {
  return CONTAINER_TYPES.has(e.type);
}

export function isServerEvent(e: EngineEvent): e is EngineEvent<ServerEventType> {
  return !CONTAINER_TYPES.has(e.type);
}

export const subjectForService = (serviceId: string) => `service:${serviceId}`;
export const subjectForNode = (nodeName: string) => `node:${nodeName}`;
