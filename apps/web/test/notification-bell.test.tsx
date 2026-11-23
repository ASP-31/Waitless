import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationBell } from "@/components/shared/notification-bell";
import { api } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: { get: vi.fn(), patch: vi.fn() },
  ApiError: class ApiError extends Error {},
  getAccessToken: () => null,
  apiUrl: (path: string) => path,
}));

const sample = {
  notifications: [
    {
      id: "n1",
      type: "QUEUE_UPDATED",
      channel: "IN_APP",
      status: "SENT",
      title: "Your turn is coming up",
      body: "2 patients ahead of you.",
      data: null,
      appointmentId: "a1",
      readAt: null,
      createdAt: "2026-01-01T10:00:00.000Z",
      sentAt: "2026-01-01T10:00:00.000Z",
      scheduledFor: null,
    },
  ],
  unread: 2,
};

function renderBell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NotificationBell />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("NotificationBell", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockResolvedValue({ data: sample } as never);
    vi.mocked(api.patch).mockResolvedValue({} as never);
  });

  it("exposes the unread count and opens the notification list", async () => {
    const user = userEvent.setup();
    renderBell();

    const button = await screen.findByRole("button", { name: "Notifications, 2 unread" });
    expect(button).toBeInTheDocument();
    expect(screen.queryByText(sample.notifications[0]!.title)).not.toBeInTheDocument();

    await user.click(button);
    expect(await screen.findByRole("dialog", { name: "Notifications" })).toBeInTheDocument();
    expect(screen.getByText(sample.notifications[0]!.title)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Mark ${sample.notifications[0]!.title} as read` })).toBeInTheDocument();
  });
});
