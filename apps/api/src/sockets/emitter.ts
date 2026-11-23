import { getIo } from "./index";

function safeEmit(room: string, event: string, payload: unknown) {
  try {
    getIo().to(room).emit(event, payload);
  } catch {
    // sockets not initialized (e.g. tests/scripts)
  }
}

export const socketEmitter = {
  queueUpdated(doctorId: string, payload: unknown) {
    safeEmit(`doctor:${doctorId}`, "queue:updated", payload);
    safeEmit("admin:queue", "queue:updated", payload);
  },
  appointmentUpdated(patientId: string | null | undefined, payload: unknown) {
    if (patientId) safeEmit(`patient:${patientId}`, "appointment:updated", payload);
    safeEmit("admin:queue", "appointment:updated", payload);
  },
  notificationNew(userId: string | null | undefined, patientId: string | null | undefined, payload: unknown) {
    if (patientId) safeEmit(`patient:${patientId}`, "notification:new", payload);
    if (userId) safeEmit(`user:${userId}`, "notification:new", payload);
  },
  queueCalled(doctorId: string, patientId: string | null | undefined, payload: unknown) {
    safeEmit(`doctor:${doctorId}`, "queue:called", payload);
    safeEmit("admin:queue", "queue:called", payload);
    if (patientId) safeEmit(`patient:${patientId}`, "queue:called", payload);
  },
  swapRequested(targetPatientId: string, payload: unknown) {
    safeEmit(`patient:${targetPatientId}`, "swap:requested", payload);
    safeEmit("admin:queue", "swap:requested", payload);
  },
  swapResponded(patientIds: Array<string | null | undefined>, payload: unknown) {
    for (const patientId of patientIds) {
      if (patientId) safeEmit(`patient:${patientId}`, "swap:responded", payload);
    }
    safeEmit("admin:queue", "swap:responded", payload);
  },
  hardwareOccupancy(doctorId: string | null | undefined, payload: unknown) {
    if (doctorId) safeEmit(`doctor:${doctorId}`, "hardware:occupancy", payload);
    safeEmit("admin:queue", "hardware:occupancy", payload);
  },
};
