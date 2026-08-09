import { beforeEach, describe, expect, it } from "bun:test";
import { clearToken, getCreator, getToken, setSession, subscribeToAuth, TOKEN_STORAGE_KEY } from "./auth";

const CREATOR = { id: "creator-1", name: "Budi", email: "budi@example.com" };

beforeEach(() => {
  localStorage.clear();
});

describe("dashboard auth storage", () => {
  it("round-trips a token through localStorage under one key", () => {
    expect(getToken()).toBeNull();

    setSession("jwt-abc", CREATOR);

    expect(getToken()).toBe("jwt-abc");
    // ONE key, so "log out" cannot leave half a session behind.
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBe("jwt-abc");
  });

  it("clears the token and the cached creator together", () => {
    setSession("jwt-abc", CREATOR);
    expect(getCreator()?.name).toBe("Budi");

    clearToken();

    expect(getToken()).toBeNull();
    expect(getCreator()).toBeNull();
    expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it("notifies subscribers when the token is set and when it is cleared", () => {
    const seen: Array<string | null> = [];
    const unsubscribe = subscribeToAuth(() => seen.push(getToken()));

    setSession("jwt-abc", CREATOR);
    clearToken();
    unsubscribe();
    setSession("jwt-def", CREATOR);

    // The third change lands after unsubscribing, so it must not be seen —
    // otherwise a listener outlives the component that owns it.
    expect(seen).toEqual(["jwt-abc", null]);
  });

  it("survives a creator blob that is not the JSON it expects", () => {
    // A key hand-edited in devtools, or written by an older build, must not
    // crash every screen that reads the creator's name.
    localStorage.setItem(TOKEN_STORAGE_KEY, "jwt-abc");
    localStorage.setItem("diudara.dashboard.creator", "not json");

    expect(getToken()).toBe("jwt-abc");
    expect(getCreator()).toBeNull();
  });
});
