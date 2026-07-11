import '@testing-library/jest-dom/vitest';
import { createElement } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AddServerModal } from './AddServerModal';

function healthyResponse(): Response {
  return {
    ok: true,
    json: async () => ({ status: 'healthy' }),
  } as Response;
}

describe('AddServerModal', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>());
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // Walks the add-server flow from typing a host through healthcheck and save.
  it('saves a healthy new server after the healthcheck passes', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(healthyResponse());
    const onSave = vi.fn();
    const user = userEvent.setup();

    render(createElement(AddServerModal, { onClose: vi.fn(), onSave, servers: ['localhost:9090'] }));

    await user.type(screen.getByRole('textbox', { name: /server ip address/i }), 'engine.local:9090');
    expect(await screen.findByText(/server is healthy and ready to connect/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /save server/i }));

    expect(onSave).toHaveBeenCalledWith('engine.local:9090');
    const [url, options] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/^http:\/\/engine\.local:9090\/health\?_t=/);
    expect(options).toEqual(expect.objectContaining({ method: 'GET' }));
  });

  // Ensures duplicate servers stop before network work and keep Save disabled.
  it('blocks duplicate servers without running a healthcheck', async () => {
    const fetchMock = vi.mocked(fetch);
    const user = userEvent.setup();

    render(createElement(AddServerModal, { onClose: vi.fn(), onSave: vi.fn(), servers: ['localhost:9090'] }));

    await user.type(screen.getByRole('textbox', { name: /server ip address/i }), 'localhost:9090');

    expect(await screen.findByText(/already in your list/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save server/i })).toBeDisabled();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});
