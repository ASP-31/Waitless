import { expect, test } from "@playwright/test";
import {
  bearer,
  findWaitingQueueEntry,
  listDoctors,
  queueEntryStatus,
  staffLogin,
} from "./helpers/api";

test("staff calls, starts and completes a waiting patient", async ({ request }) => {
  const staff = await staffLogin(request);
  const [doctor] = await listDoctors(request);
  expect(doctor, "seeded clinic").toBeDefined();

  const entry = await findWaitingQueueEntry(request, staff, doctor!.id);
  const headers = bearer(staff.token);
  const base = `/api/v1/queue/entries/${entry.id}`;

  const called = await request.patch(`${base}/call`, { headers });
  expect(called.status(), "call").toBe(200);
  const calledBody = (await called.json()) as { data: { entry: { status: string } } };
  expect(calledBody.data.entry.status).toBe("CALLED");

  const started = await request.patch(`${base}/start`, { headers });
  expect(started.status(), "start").toBe(200);
  const startedBody = (await started.json()) as { data: { entry: { status: string } } };
  expect(startedBody.data.entry.status).toBe("IN_CONSULTATION");

  const completed = await request.patch(`${base}/complete`, { headers });
  expect(completed.status(), "complete").toBe(200);
  const completedBody = (await completed.json()) as { data: { entry: { status: string } } };
  expect(completedBody.data.entry.status).toBe("COMPLETED");

  expect(
    await queueEntryStatus(request, staff, doctor!.id, entry.serviceDay, entry.id),
    "queue state after completion",
  ).toBe("COMPLETED");
});
