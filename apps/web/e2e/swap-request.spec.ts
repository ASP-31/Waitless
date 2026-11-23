import { expect, test } from "@playwright/test";
import {
  bearer,
  book,
  createSwap,
  findAvailableSlots,
  getAppointment,
  listDoctors,
  patientSession,
  uniquePhone,
} from "./helpers/api";

test("two patients request and accept a slot swap", async ({ request }) => {
  const requester = await patientSession(request, "E2E Swap Requester", uniquePhone());
  const target = await patientSession(request, "E2E Swap Target", uniquePhone());
  const [doctor] = await listDoctors(request);
  expect(doctor, "seeded clinic").toBeDefined();

  const [firstSlot, secondSlot] = await findAvailableSlots(request, doctor!.id, 2);
  const stamp = Date.now();
  const requesterAppointment = await book(
    request,
    requester,
    doctor!.id,
    firstSlot.start,
    `e2e-swap-book-a-${stamp}`,
  );
  const targetAppointment = await book(
    request,
    target,
    doctor!.id,
    secondSlot.start,
    `e2e-swap-book-b-${stamp}`,
  );

  const eligibleResponse = await request.post("/api/v1/swaps/eligible", {
    headers: bearer(requester.token),
    data: { appointmentId: requesterAppointment.id },
  });
  expect(eligibleResponse.status(), "eligible candidates").toBe(200);
  const eligible = (await eligibleResponse.json()) as {
    data: { eligible: Array<{ appointmentId: string }> };
  };
  expect(
    eligible.data.eligible.some((candidate) => candidate.appointmentId === targetAppointment.id),
    "target appointment should be a candidate",
  ).toBe(true);

  const swap = await createSwap(
    request,
    requester,
    requesterAppointment.id,
    targetAppointment.id,
    `e2e-swap-${stamp}`,
  );

  const accept = await request.patch(`/api/v1/swaps/${swap.id}/respond`, {
    headers: bearer(target.token),
    data: { action: "ACCEPT" },
  });
  expect(accept.status(), "accept swap").toBe(200);
  const accepted = (await accept.json()) as { data: { swap: { status: string } } };
  expect(accepted.data.swap.status).toBe("ACCEPTED");

  const afterRequester = await getAppointment(request, requester, requesterAppointment.id);
  const afterTarget = await getAppointment(request, target, targetAppointment.id);
  expect(afterRequester.slotStart).toBe(targetAppointment.slotStart);
  expect(afterTarget.slotStart).toBe(requesterAppointment.slotStart);
  expect(afterRequester.tokenNumber).toBe(targetAppointment.tokenNumber);
  expect(afterTarget.tokenNumber).toBe(requesterAppointment.tokenNumber);
});
