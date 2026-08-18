# Phase 3 gate — manual checklist

Run against commit `e2d742e` or later. **Nothing here is automated; this is the browser half that
happy-dom structurally cannot answer.** The last automated gate was 59/59 at `de84e4a`; the three
things marked **NEW** are what changed since.

---

## 0. Start the two servers

**Terminal 1 — the API, with messaging disabled:**

```bash
cd apps/api
NODE_ENV=development TELEGRAM_BOT_TOKEN= FONNTE_API_TOKEN= bun run dev
```

**Then read the boot log and confirm this line:**

```
[bootstrap] messaging providers: FakeMessagingAdapter (gating) + FakeMessagingAdapter (notification)
```

If it names `TelegramBotAdapter` or `FonnteWhatsAppAdapter` instead, **stop.** Those are live
credentials and this checklist signs up accounts. Blank the two tokens in `apps/api/.env` for the
duration instead, and restart.

**Terminal 2 — the web app:**

```bash
cd apps/web
bun run vite --config vite.gate.config.ts
```

`vite.gate.config.ts` is untracked and exists only on this machine. Port 3000 here is Grafana, so the
API runs on 3004; this config imports the real `vite.config.ts` and rewrites **only** the proxy
target, leaving the proxy table exactly as shipped. Use `GATE_API_PORT=3005 bun run vite --config
vite.gate.config.ts` if 3004 is busy.

Open **http://localhost:5173**.

> **Note:** this writes to your real dev database. Cleanup at the bottom.

---

## 1. The proxy is alive (the check that exists because of Phase 2)

Open <http://localhost:5173/jelajah>.

- ✅ The page renders and lists people (or an empty-state message).
- ❌ **A blank page, or an error mentioning JSON/HTML** — the proxy is serving `index.html` instead of
  forwarding to the API. This is the failure that broke six pages in Phase 2 and it is invisible to
  every unit test. Nothing below is meaningful until this passes.

## 2. Reserved handles — **NEW** (shipped in `e2d742e`)

At <http://localhost:5173/signup>:

| Handle you type | Expected |
|---|---|
| `posts` | Rejected: **"Handle ini sudah digunakan. Coba handle lain."** |
| `feed` | Same rejection |
| `@Posts` | Same rejection — normalisation happens before the check |
| `postscript` | **Accepted** — only a whole segment collides, not a word inside one |

Now create the real test account: handle `uji_coba`, any email, password ≥ 8 chars, **leave WhatsApp
empty**. Sign in at <http://localhost:5173/masuk>.

## 3. Seed 25 posts

Twenty-five, because the bug in §5 only appears well below the fold. Run this in a third terminal —
replace the email and password with the account you just made:

```bash
TOKEN=$(curl -s localhost:3004/users/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"YOUR@EMAIL","password":"YOURPASSWORD"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)

for i in $(seq 1 25); do
  curl -s -o /dev/null localhost:3004/users/posts \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"body\":\"kiriman uji nomor $i\"}"
done
echo "done"
```

Reload <http://localhost:5173/beranda>. You should see 20 posts and a **"Muat lebih banyak"** button;
pressing it loads the remaining 5 and the button disappears. No post should appear twice.

## 4. Tab switch mid-load — **NEW** (finding C1)

The one that needs a slow network to see at all.

1. Open DevTools → **Network** tab → throttling dropdown → **Slow 3G**.
2. Go to `/beranda`, make sure **Untuk Anda** is selected, and reload.
3. **While the posts are still loading**, click **Mengikuti**.

- ✅ Mengikuti shows its own result — with a fresh account following nobody, that is
  **"Belum ada kiriman dari orang yang Anda ikuti."**
- ❌ **Your own posts appear under Mengikuti.** That is the bug: the old request landed after the tab
  changed and overwrote the new list. It is impossible for real — the database forbids following
  yourself — so if you see your own post there, the fix has regressed.

Switch back and forth a few times while loading. The list must always match the selected tab.

Turn throttling off afterwards.

## 5. Tapping Hapus far down the feed — **NEW** (finding I2)

**This one only reproduces at phone width.** DevTools → device toolbar (Ctrl+Shift+M) → **390px**
wide, or narrow the window to about 390px.

1. On `/beranda`, scroll to the **bottom** of the feed — post 20 or so.
2. Tap **Hapus** on that last post.

- ✅ The page **scrolls to the confirmation panel** ("Hapus kiriman ini?") and the panel is
  **focused** — press Escape/Tab and you can tell focus is on it, not lost on the page body.
- ❌ **Nothing appears to happen.** The panel opened 20 rows above where you're looking. That was the
  bug: from roughly the sixth post down, Hapus and Edit looked dead on a phone.

3. Press **Tidak jadi**, then tap **Edit** on that same bottom post.

- ✅ The composer scrolls into view **with the caret already in the text box**, pre-filled with that
  post's text.

4. Without saving, scroll away, then tap **Hapus** on a *different* post.

- ✅ The panel reveals itself again for the new post. (It never unmounted — it must still scroll and
  refocus.)

## 6. Edit and delete from a profile (the shared hook — **NEW**)

Both pages now run the same code, so the profile needs its own pass.

1. Go to <http://localhost:5173/@uji_coba>.
2. Edit a post far down the list → composer scrolls into view, caret in the box. Change the text,
   **Simpan**.
   - ✅ The row updates and shows **"· diedit"**.
3. Delete a post from the profile.
   - ✅ It disappears from the profile, **and** from `/beranda`, **and** is still gone after a reload.
     (The delete is soft in the database, but it must be invisible on both read paths.)

## 7. Signed out

Sign out, then open `/beranda`.

- ✅ **Untuk Anda** still loads posts.
- ✅ The composer is **absent**.
- ✅ **Mengikuti** reads "Masuk untuk melihat" and — DevTools → Network — fires **zero** feed
  requests when you select it.

Open `/@uji_coba` while signed out:

- ✅ The posts are visible, and **no Edit or Hapus buttons** anywhere.

## 8. Both layouts

- At **390px**: the bottom nav bar is visible, the side rail is not.
- At **1440px**: the side rail is visible, the bottom nav is not.
- All four destinations (Beranda, Jelajah, Siaran, Pengaturan) render at both widths.

## 9. The old dashboard still works

Open `/dashboard`. It is scheduled for deletion in Phase 8 and must keep running untouched until
then. A login screen or the communities list is a pass.

---

## Cleanup

The test account and its posts sit in your dev database. To remove them:

```sql
DELETE FROM app_user WHERE handle IN ('uji_coba', 'postscript');
```

Posts are removed with the account by cascade. Leave them if you'd rather keep the fixture.

---

## If something fails

Note **which numbered step**, what you saw, and the browser width — then hand it back. Steps 4, 5 and
6 are the ones testing code that has never been exercised in a real browser; 1, 7, 8 and 9 are
regression checks that passed at `de84e4a`, so a failure there means something recent broke them.
