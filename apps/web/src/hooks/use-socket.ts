import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";
import { useAuth } from "@/context/auth-context";
import { getAccessToken } from "@/lib/api";

export type RealtimeEvent =
  | "queue:updated"
  | "appointment:updated"
  | "notification:new"
  | "swap:requested"
  | "swap:responded"
  | "hardware:occupancy";

export type RealtimeListener = (event: RealtimeEvent, payload: unknown) => void;

const EVENTS: RealtimeEvent[] = [
  "queue:updated",
  "appointment:updated",
  "notification:new",
  "swap:requested",
  "swap:responded",
  "hardware:occupancy",
];

// One connection for the whole app. Layouts, pages and wall displays all share
// it; each hook instance only contributes an event listener and any doctor
// rooms it needs.
let socket: Socket | null = null;
let queryClient: QueryClient | null = null;
let coreAttached = false;
let activeHooks = 0;
let connected = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffStep = 0;
const listeners = new Set<RealtimeListener>();
const connectionListeners = new Set<(value: boolean) => void>();
const doctorRooms = new Set<string>();

function syncAuth() {
  // Always read the current token: it may have been rotated since the socket
  // was created (the API client refreshes it in place via setAccessToken).
  const token = getAccessToken();
  if (socket) socket.auth = token ? { token } : {};
}

function ensureSocket(): Socket {
  if (!socket) {
    socket = io("/", {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      withCredentials: true,
      autoConnect: false,
      reconnection: false, // manual exponential backoff below
      auth: {},
    });
  }
  syncAuth();
  return socket;
}

function notifyConnected(value: boolean) {
  connected = value;
  for (const notify of connectionListeners) notify(value);
}

function joinDoctorRooms(instance: Socket) {
  for (const doctorId of doctorRooms) instance.emit("queue:joinDoctor", doctorId);
}

function scheduleReconnect() {
  if (!activeHooks || reconnectTimer || !socket) return;
  const delay = Math.min(30_000, 1000 * 2 ** backoffStep) + Math.floor(Math.random() * 250);
  backoffStep += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!activeHooks || !socket) return;
    syncAuth();
    socket.connect();
  }, delay);
}

function invalidateFor(event: RealtimeEvent, client: QueryClient) {
  switch (event) {
    case "queue:updated":
      void client.invalidateQueries({ queryKey: ["queue"] });
      void client.invalidateQueries({ queryKey: ["appointments"] });
      void client.invalidateQueries({ queryKey: ["doctors"] });
      break;
    case "appointment:updated":
      void client.invalidateQueries({ queryKey: ["appointments"] });
      void client.invalidateQueries({ queryKey: ["queue"] });
      break;
    case "notification:new":
      void client.invalidateQueries({ queryKey: ["notifications"] });
      break;
    case "swap:requested":
    case "swap:responded":
      void client.invalidateQueries({ queryKey: ["swaps"] });
      void client.invalidateQueries({ queryKey: ["appointments"] });
      break;
    case "hardware:occupancy":
      void client.invalidateQueries({ queryKey: ["hardware"] });
      void client.invalidateQueries({ queryKey: ["rooms"] });
      void client.invalidateQueries({ queryKey: ["queue"] });
      break;
  }
}

function attachCoreListeners(instance: Socket) {
  if (coreAttached) return;
  coreAttached = true;

  for (const event of EVENTS) {
    instance.on(event, (payload: unknown) => {
      if (queryClient) invalidateFor(event, queryClient);
      // The API also uses appointment:updated as a swap notification carrier.
      const resolved: RealtimeEvent =
        event === "appointment:updated" &&
        typeof payload === "object" &&
        payload !== null &&
        "type" in payload &&
        typeof payload.type === "string" &&
        payload.type.startsWith("swap:")
          ? (payload.type as RealtimeEvent)
          : event;
      for (const listener of listeners) listener(resolved, payload);
    });
  }

  instance.on("connect", () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    backoffStep = 0;
    syncAuth();
    joinDoctorRooms(instance);
    notifyConnected(true);
  });

  instance.on("connect_error", () => {
    notifyConnected(false);
    syncAuth();
    scheduleReconnect();
  });

  instance.on("disconnect", () => {
    notifyConnected(false);
    scheduleReconnect();
  });
}

export interface UseSocketOptions {
  /** Extra rooms to join (e.g. the doctor whose queue a wall display shows). */
  doctorIds?: string[];
  /** Per-page callback, invoked in addition to the shared query invalidation. */
  onEvent?: RealtimeListener;
  enabled?: boolean;
}

export function useSocket(options: UseSocketOptions = {}) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [isConnected, setIsConnected] = useState(connected);
  const listenerRef = useRef(options.onEvent);
  const enabled = options.enabled !== false;
  const doctorKey = options.doctorIds?.slice().sort().join("|") ?? "";
  const userId = user?.id;

  useEffect(() => {
    listenerRef.current = options.onEvent;
  }, [options.onEvent]);

  useEffect(() => {
    if (!enabled || !userId) return;

    queryClient = qc;
    activeHooks += 1;

    const rooms = doctorKey ? doctorKey.split("|").filter(Boolean) : [];
    for (const room of rooms) doctorRooms.add(room);

    const listener: RealtimeListener = (event, payload) => {
      listenerRef.current?.(event, payload);
    };
    listeners.add(listener);
    connectionListeners.add(setIsConnected);

    const instance = ensureSocket();
    attachCoreListeners(instance);
    if (instance.connected) joinDoctorRooms(instance);
    else instance.connect();

    return () => {
      listeners.delete(listener);
      connectionListeners.delete(setIsConnected);
      for (const room of rooms) doctorRooms.delete(room);
      activeHooks = Math.max(0, activeHooks - 1);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (activeHooks === 0) {
        notifyConnected(false);
        instance.disconnect();
        backoffStep = 0;
      }
    };
  }, [qc, userId, enabled, doctorKey]);

  return { connected: isConnected };
}
