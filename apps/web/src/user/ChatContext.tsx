import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

interface ChatRequest {
  handle: string;
}

interface ChatContextValue {
  /** The most recent "open a conversation with this handle" ask, or none. */
  request: ChatRequest | null;
  /** Asks the floating `ChatPanel` to open (or start) a conversation with `handle`. */
  requestConversation: (handle: string) => void;
  /** `ChatPanel` calls this once it has acted on `request`. */
  clearRequest: () => void;
}

/**
 * A no-op default rather than `null` + a throwing hook: `ChatPanel.test.tsx`
 * renders `<ChatPanel />` on its own, with no provider above it, and that must
 * keep working — a chat button rendered without `ChatProvider` should simply
 * do nothing, not crash the page it sits on.
 */
const NOOP: ChatContextValue = {
  request: null,
  requestConversation: () => {},
  clearRequest: () => {},
};

const ChatContext = createContext<ChatContextValue>(NOOP);

/**
 * Lets any page ask the floating `ChatPanel` (mounted once, in `AppShell`) to
 * open a conversation with a given handle — the Anggota roster's "message
 * this member" button, for one — without either side holding a ref to the
 * other. `AppShell` wraps its whole tree in this so `ChatPanel` and every
 * routed page share the one instance.
 */
export function ChatProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ChatRequest | null>(null);
  const value = useMemo<ChatContextValue>(
    () => ({
      request,
      requestConversation: (handle: string) => setRequest({ handle }),
      clearRequest: () => setRequest(null),
    }),
    [request]
  );
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

export function useChatContext(): ChatContextValue {
  return useContext(ChatContext);
}
