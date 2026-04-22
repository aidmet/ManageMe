/**
 * This file will automatically be loaded by webpack and run in the "renderer" context.
 * To learn more about the differences between the "main" and "renderer" context in
 * Electron, visit:
 *
 * https://electronjs.org/docs/latest/tutorial/process-model
 */

import './index.css';
import {
    cycleTheme,
    getTheme,
    initThemeFromStorage,
    setTheme,
    themePreferenceLabel,
    type ThemePreference,
} from './theme';
import { FirebaseError } from 'firebase/app';
import type { User } from 'firebase/auth';
import {
    createUserWithEmailAndPassword,
    onAuthStateChanged,
    sendPasswordResetEmail,
    signInWithEmailAndPassword,
    signOut,
    updateProfile,
} from 'firebase/auth';
import { auth, db } from './firebase';
import {
    addDoc,
    collection,
    deleteDoc,
    doc,
    getDoc,
    getDocs,
    limit,
    onSnapshot,
    orderBy,
    query,
    runTransaction,
    serverTimestamp,
    setDoc,
    Timestamp,
    updateDoc,
    where,
} from 'firebase/firestore';
import type { QueryDocumentSnapshot, Unsubscribe } from 'firebase/firestore';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

// =========================
// Core types and IPC bridge
// =========================

type AuthMode = 'signin' | 'signup';

type AppUpdatePayload = {
    releaseName: string;
    releaseNotes: string;
};

type CheckForUpdatesResult =
    | { ok: true; kind: 'no_update' }
    | { ok: true; kind: 'update_available' }
    | { ok: false; kind: 'not_packaged' }
    | { ok: false; kind: 'error'; message: string };

declare global {
    interface Window {
        manageMeDesktop?: {
            setWindowBackgroundColor?: (hex: string) => void;
            onUpdateReady: (
                callback: (payload: AppUpdatePayload) => void
            ) => () => void;
            installUpdate: () => void;
            checkForUpdates: () => Promise<CheckForUpdatesResult>;
            showNativeNotification: (opts: {
                title: string;
                body: string;
            }) => void;
        };
    }
}

marked.setOptions({ gfm: true });

let domPurifyLinkHookInstalled = false;
function installDomPurifyLinkHook(): void {
    if (domPurifyLinkHookInstalled) {
        return;
    }
    domPurifyLinkHookInstalled = true;
    DOMPurify.addHook('afterSanitizeAttributes', (node) => {
        if (node.tagName !== 'A') {
            return;
        }
        const el = node as HTMLAnchorElement;
        const href = el.getAttribute('href');
        if (!href || !/^https?:\/\//i.test(href)) {
            return;
        }
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
    });
}

/** Assistant replies are Markdown; sanitize before innerHTML. User bubbles stay plain text. */
function assistantMarkdownToSafeHtml(source: string): string {
    installDomPurifyLinkHook();
    const html = marked.parse(source, { async: false }) as string;
    return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

initThemeFromStorage();

document.addEventListener('click', (e) => {
    const seg = (e.target as HTMLElement).closest(
        '.theme-seg-btn[data-theme-pref]'
    ) as HTMLButtonElement | null;
    if (seg) {
        const p = seg.dataset.themePref;
        if (p === 'light' || p === 'dark' || p === 'system') {
            setTheme(p);
            syncThemePreferenceUi();
        }
        return;
    }
    if ((e.target as HTMLElement).closest('#theme-cycle-btn')) {
        cycleTheme();
        syncThemePreferenceUi();
    }
});

function themeToggleStripHtml(): string {
    return `
    <div class="theme-toggle-strip" role="group" aria-label="Color theme">
        <span class="theme-toggle-strip-label">Theme</span>
        <div class="theme-toggle-segment">
            <button type="button" class="theme-seg-btn" data-theme-pref="light" aria-pressed="false">Light</button>
            <button type="button" class="theme-seg-btn" data-theme-pref="dark" aria-pressed="false">Dark</button>
            <button type="button" class="theme-seg-btn" data-theme-pref="system" aria-pressed="false">System</button>
        </div>
    </div>`;
}

function syncThemePreferenceUi(): void {
    const cur = getTheme();
    document
        .querySelectorAll<HTMLButtonElement>('.theme-seg-btn[data-theme-pref]')
        .forEach((btn) => {
            const p = btn.dataset.themePref as ThemePreference;
            const active = p === cur;
            btn.classList.toggle('theme-seg-btn--active', active);
            btn.setAttribute('aria-pressed', String(active));
        });
    const cyc = document.getElementById('theme-cycle-btn');
    if (cyc) {
        cyc.textContent = `Theme: ${themePreferenceLabel(cur)}`;
    }
}

const INVITES_COLLECTION = 'invites';
const INVITE_EXPIRY_DAYS = 30;
const COMPANY_NEWS_SUBCOLLECTION = 'news';
const HOLIDAY_REQUESTS_SUBCOLLECTION = 'holidayRequests';
const USER_NOTEBOOKS_COLLECTION = 'userNotebooks';
const NEWS_BODY_MAX_LENGTH = 6000;
const NOTEBOOK_MAX_LENGTH = 50000;
const NOTEBOOK_AUTOSAVE_MS = 900;
const MEETINGS_SUBCOLLECTION = 'meetings';
const MEETING_TITLE_MAX_LENGTH = 200;
const MEETING_LOCATION_MAX_LENGTH = 200;
const MEETING_URL_MAX_LENGTH = 500;
const MEETING_NOTES_MAX_LENGTH = 2000;
const MEETINGS_QUERY_LIMIT = 100;
const MEMBER_MESSAGES_SUBCOLLECTION = 'memberMessages';
const MEMBER_MESSAGE_BODY_MAX_LENGTH = 4000;
const DM_THREAD_QUERY_LIMIT = 100;
const DM_NOTIFICATION_BODY_MAX = 180;
const WELCOME_COMPANY_NEWS_AUTHOR = 'The ManageMe Team';

/** Chats keyed by Firebase uid. Rules: allow read/write only when request.auth.uid == uid. */
const USER_AI_CHATS_COLLECTION = 'userAiChats';
const MANAGE_ME_CHAT_API = 'https://manage-me-api.vercel.app/api/chat';
const DEFAULT_AI_MODEL = 'gpt-4.1-mini';
const AI_CHAT_MESSAGES_CAP = 100;
const AI_TOOL_LOOP_MAX = 12;

/** Sent on every chat request as Responses API `instructions` (system behavior). */
const MANAGE_ME_AI_INSTRUCTIONS = `You help users inside ManageMe.

About ManageMe:
- ManageMe is a desktop company workspace (Electron) for running an organization in one place: people, roles, and structure.
- Each user works inside a company they joined or created. The dashboard is the home surface: company news, meetings, direct messages, a personal notebook, holiday requests (where enabled), employee directory, team/role management (for those with access), and an audit trail for owners.
- Membership uses roles (e.g. owner, manager-style roles, members). Some roles are "high up" and can send and manage invitations. Invitation types and labels come from the company's configured invite roles—never invent role keys.
- Company news is visible to everyone in the company. Meetings have title, time range, optional location and video link, and notes. Direct messages go to one teammate (matched by email or display name). Holiday requests go to the company owner and depend on the member having a holiday allowance.
- You only act through the tools provided. You cannot browse the web, read email, or change ManageMe settings (theme, sign-out, etc.) for the user. If they ask for something outside your tools, explain briefly and suggest what they can do in the app UI.

Tone and style:
- Write in a mix of informal and formal: friendly, clear, and professional.
- Keep responses pleasant and a bit conversational without slang overload.
- Be concise, but still warm and easy to talk to.

Invitation workflow (mandatory):
1. When the user wants to invite someone or asks you to create an invitation, you MUST call the list_invitation_roles tool first so you know the exact role \`name\` values for this company.
2. Do NOT call create_invitation in the same model response as list_invitation_roles. After that tool returns, in a later step you may call create_invitation when the rules below are satisfied.
3. Immediately before create_invitation, give a short recap (in the same turn as the tool call is fine): invitee name, the exact role \`name\` you will use from list_invitation_roles, and that invitations expire in the usual way.
4. When to require an extra confirmation: If the user already clearly instructed you to create the invite with a specific person and role (e.g. "please invite Vicky as Sales", "invite Sam as member", "add them as Admin"), treat that as approval—after list_invitation_roles and your recap, call create_invitation without asking them to say "yes" again. If the request is vague, incomplete, or exploratory ("can we invite people?", "maybe add someone", no role or no name), ask for what's missing or ask them to confirm before you call create_invitation. If they decline or sound unsure, do not create.
5. Never guess a role string for create_invitation; it must match a \`name\` from list_invitation_roles.
6. After a successful create_invitation, always show the exact invitationId from the tool result in the reply.

For other actions, follow tool descriptions and be concise.`;

type AiChatStoredMessage = {
    role: 'user' | 'assistant';
    content: string;
};

type AiFunctionCallPayload = {
    call_id: string;
    name: string;
    arguments: string;
};

/** Tool schemas forwarded to OpenAI; execution happens in the renderer after the API returns function calls. */
const MANAGE_ME_AI_TOOLS: Record<string, unknown>[] = [
    {
        type: 'function',
        name: 'get_company_snapshot',
        description:
            'Read-only: company name, your role, and counts (members, teams). Use before other tools if context is unclear.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        type: 'function',
        name: 'get_directory',
        description:
            'Read-only: list people in the company directory (name, email, role, status). Optional filter substring.',
        parameters: {
            type: 'object',
            properties: {
                filter: {
                    type: 'string',
                    description:
                        'Optional: match name, email, role, or status (case-insensitive substring).',
                },
            },
            additionalProperties: false,
        },
    },
    {
        type: 'function',
        name: 'list_meetings',
        description:
            'Read-only: upcoming meetings (title, time range, organizer, location, link).',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        type: 'function',
        name: 'list_invitation_roles',
        description:
            'Read-only: invitation roles configured for this company (exact `name` values to pass to create_invitation, plus display label and whether the role is "high up" for invite permissions).',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
        type: 'function',
        name: 'post_company_news',
        description:
            'Post a message to company news (visible to everyone in the company).',
        parameters: {
            type: 'object',
            properties: {
                body: {
                    type: 'string',
                    description: 'News text to post.',
                },
            },
            required: ['body'],
            additionalProperties: false,
        },
    },
    {
        type: 'function',
        name: 'schedule_meeting',
        description:
            'Create a company meeting. Use ISO 8601 datetimes in the device/local timezone offset, e.g. 2026-04-22T15:00:00.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                start_iso: { type: 'string', description: 'ISO 8601 start time' },
                end_iso: { type: 'string', description: 'ISO 8601 end time' },
                location: { type: 'string', description: 'Optional' },
                meeting_url: { type: 'string', description: 'Optional video URL' },
                notes: { type: 'string', description: 'Optional agenda or notes' },
            },
            required: ['title', 'start_iso', 'end_iso'],
            additionalProperties: false,
        },
    },
    {
        type: 'function',
        name: 'send_direct_message',
        description:
            'Send a direct message to a teammate. Identify them by email or display name (unique match required).',
        parameters: {
            type: 'object',
            properties: {
                peer_identifier: {
                    type: 'string',
                    description: 'Email or person name',
                },
                message: { type: 'string' },
            },
            required: ['peer_identifier', 'message'],
            additionalProperties: false,
        },
    },
    {
        type: 'function',
        name: 'request_holiday_days',
        description:
            'Submit a holiday request to the company owner. Requires a holiday balance to be set.',
        parameters: {
            type: 'object',
            properties: {
                days: { type: 'integer', minimum: 1 },
            },
            required: ['days'],
            additionalProperties: false,
        },
    },
    {
        type: 'function',
        name: 'create_invitation',
        description:
            'Create an invitation for someone to join the company. Requires permission to send invites. Call list_invitation_roles first to get valid `role` values (use each role\'s `name` field).',
        parameters: {
            type: 'object',
            properties: {
                invitee_name: { type: 'string' },
                role: { type: 'string', description: 'Role key, e.g. member' },
            },
            required: ['invitee_name', 'role'],
            additionalProperties: false,
        },
    },
];

function normalizeAiChatMessages(raw: unknown): AiChatStoredMessage[] {
    if (!Array.isArray(raw)) {
        return [];
    }
    const out: AiChatStoredMessage[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const o = item as Record<string, unknown>;
        const role = o.role;
        const content = o.content;
        if (
            (role === 'user' || role === 'assistant') &&
            typeof content === 'string'
        ) {
            const t = content.trim();
            if (t) {
                out.push({ role, content: t });
            }
        }
    }
    return out.slice(-AI_CHAT_MESSAGES_CAP);
}

function capAiMessages(messages: AiChatStoredMessage[]): AiChatStoredMessage[] {
    if (messages.length <= AI_CHAT_MESSAGES_CAP) {
        return messages;
    }
    return messages.slice(-AI_CHAT_MESSAGES_CAP);
}

function parseOpenAiChatResponse(data: unknown): {
    id: string | null;
    outputText: string | null;
    functionCalls: AiFunctionCallPayload[];
} {
    if (!data || typeof data !== 'object') {
        return { id: null, outputText: null, functionCalls: [] };
    }
    const d = data as Record<string, unknown>;
    const id = typeof d.id === 'string' ? d.id : null;
    /** Built only from `output` message items — avoids duplicating top-level `output_text`. */
    let textFromOutput: string | null = null;
    const functionCalls: AiFunctionCallPayload[] = [];
    const output = d.output;
    if (Array.isArray(output)) {
        for (const item of output) {
            if (!item || typeof item !== 'object') {
                continue;
            }
            const o = item as Record<string, unknown>;
            const typ = o.type;
            if (typ === 'function_call') {
                const callIdRaw = o.call_id ?? o.id;
                const call_id =
                    typeof callIdRaw === 'string' ? callIdRaw : '';
                const name = typeof o.name === 'string' ? o.name : '';
                const args =
                    typeof o.arguments === 'string'
                        ? o.arguments
                        : JSON.stringify(o.arguments ?? {});
                if (call_id && name) {
                    functionCalls.push({ call_id, name, arguments: args });
                }
            }
            if (typ === 'message' && o.role === 'assistant') {
                const content = o.content;
                if (Array.isArray(content)) {
                    for (const c of content) {
                        if (!c || typeof c !== 'object') {
                            continue;
                        }
                        const p = c as Record<string, unknown>;
                        if (
                            p.type === 'output_text' &&
                            typeof p.text === 'string' &&
                            p.text.trim()
                        ) {
                            textFromOutput = textFromOutput
                                ? `${textFromOutput}\n${p.text.trim()}`
                                : p.text.trim();
                        }
                    }
                }
            }
        }
    }
    const rootOutputText =
        typeof d.output_text === 'string' && d.output_text.trim()
            ? d.output_text.trim()
            : null;
    const outputText = textFromOutput?.trim()
        ? textFromOutput.trim()
        : rootOutputText;
    return {
        id,
        outputText: outputText?.trim() || null,
        functionCalls,
    };
}

async function postManageMeChatApi(
    idToken: string,
    body: Record<string, unknown>
): Promise<
    | { ok: true; data: unknown }
    | { ok: false; status: number; message: string }
> {
    let res: Response;
    try {
        res = await fetch(MANAGE_ME_CHAT_API, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${idToken}`,
            },
            body: JSON.stringify(body),
        });
    } catch (e) {
        return {
            ok: false,
            status: 0,
            message: e instanceof Error ? e.message : 'Network error',
        };
    }
    const text = await res.text();
    if (!res.ok) {
        return {
            ok: false,
            status: res.status,
            message: text.slice(0, 2000) || res.statusText,
        };
    }
    try {
        return { ok: true, data: JSON.parse(text) as unknown };
    } catch {
        return {
            ok: false,
            status: res.status,
            message: 'Chat API returned invalid JSON.',
        };
    }
}

// =========================
// Shared utility helpers
// =========================

function memberMessageDocSortKey(d: QueryDocumentSnapshot): number {
    const x = d.data().createdAt;
    if (x instanceof Timestamp) {
        return x.toMillis();
    }
    return 0;
}

function mergeMemberMessageDocSnapshots(
    docsOut: QueryDocumentSnapshot[],
    docsIn: QueryDocumentSnapshot[]
): QueryDocumentSnapshot[] {
    const byId = new Map<string, QueryDocumentSnapshot>();
    for (const d of docsOut) {
        byId.set(d.id, d);
    }
    for (const d of docsIn) {
        byId.set(d.id, d);
    }
    const merged = [...byId.values()].sort(
        (a, b) => memberMessageDocSortKey(a) - memberMessageDocSortKey(b)
    );
    return merged.length > DM_THREAD_QUERY_LIMIT
        ? merged.slice(-DM_THREAD_QUERY_LIMIT)
        : merged;
}

function toDatetimeLocalValue(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseDatetimeLocalToDate(value: string): Date | null {
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const d = new Date(trimmed);
    if (Number.isNaN(d.getTime())) {
        return null;
    }
    return d;
}

function meetingRangeLabel(startAt: unknown, endAt: unknown): string {
    const s = startAt instanceof Timestamp ? startAt.toDate() : null;
    const e = endAt instanceof Timestamp ? endAt.toDate() : null;
    if (!s || !e) {
        return '—';
    }
    const opts: Intl.DateTimeFormatOptions = {
        dateStyle: 'medium',
        timeStyle: 'short',
    };
    return `${s.toLocaleString(undefined, opts)} – ${e.toLocaleString(undefined, opts)}`;
}

function safeHttpUrlForHref(url: string): string | null {
    const t = url.trim();
    if (/^https:\/\//i.test(t) || /^http:\/\//i.test(t)) {
        return t;
    }
    return null;
}

function buildWelcomeCompanyNewsBody(companyName: string): string {
    const cn = companyName.trim() || 'your company';
    return `Welcome to ${cn}! Here is a quick guide to ManageMe.

Company news - Share updates everyone in the company can read. Anyone can post here.

Directory & teams - See who is in your organization, filter with search, and export a CSV. Organize people into teams and assign membership when you edit someone in the directory.

Invitations - Use Settings, then Make an invitation, to add teammates. Share the invitation ID with them before it expires.

Holiday requests - Request time off once your owner sets your holiday allowance.

Meetings - Schedule meetings with start and end times, optional location, and a video link so everyone sees what is coming up.

My notebook - Private notes only you can see.

Settings - Sign out, manage holidays (owners), transfer ownership (owners), and use Check for updates on the sign-in screen to grab the latest app version after we ship fixes.

You are set - invite your team and run the company from one place.`;
}

type InviteRoleEntry = {
    name: string;
    highUp: boolean;
};

function formatRoleForDisplay(role: string): string {
    const t = role.trim();
    if (!t) {
        return 'Member';
    }
    return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

function defaultInviteRoleEntries(): InviteRoleEntry[] {
    return [
        { name: 'member', highUp: false },
        { name: 'manager', highUp: true },
        { name: 'admin', highUp: true },
    ];
}

function roleNameImpliesHighUp(name: string): boolean {
    const n = name.trim().toLowerCase();
    return n === 'manager' || n === 'admin';
}

function normalizeInviteRoleEntries(data: unknown): InviteRoleEntry[] {
    if (!Array.isArray(data) || data.length === 0) {
        return defaultInviteRoleEntries();
    }
    const first = data[0];
    if (typeof first === 'string') {
        const names = (data as string[])
            .map((s) => String(s).trim())
            .filter(Boolean);
        if (names.length === 0) {
            return defaultInviteRoleEntries();
        }
        return names.map((name) => ({
            name,
            highUp: roleNameImpliesHighUp(name),
        }));
    }
    const out: InviteRoleEntry[] = [];
    for (const item of data) {
        if (!item || typeof item !== 'object' || !('name' in item)) {
            continue;
        }
        const name = String((item as { name: unknown }).name).trim();
        if (!name) {
            continue;
        }
        const highUpRaw = (item as { highUp?: unknown }).highUp;
        const highUp = highUpRaw === true || roleNameImpliesHighUp(name);
        out.push({ name, highUp });
    }
    return out.length > 0 ? out : defaultInviteRoleEntries();
}

function canUserSendInvitations(
    isOwner: boolean,
    employeeRoleRaw: string,
    entries: InviteRoleEntry[]
): boolean {
    if (isOwner) {
        return true;
    }
    if (roleNameImpliesHighUp(employeeRoleRaw)) {
        return true;
    }
    const r = employeeRoleRaw.trim().toLowerCase();
    const match = entries.find((e) => e.name.toLowerCase() === r);
    return match?.highUp === true;
}

function fillInviteRoleSelect(
    select: HTMLSelectElement,
    entries: InviteRoleEntry[]
): void {
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Choose a role';
    select.appendChild(placeholder);
    for (const e of entries) {
        const opt = document.createElement('option');
        opt.value = e.name;
        opt.textContent = formatRoleForDisplay(e.name);
        select.appendChild(opt);
    }
}

function getErrorCode(error: unknown): string | null {
    if (error instanceof FirebaseError) {
        return error.code;
    }
    if (error && typeof error === 'object' && 'code' in error) {
        const c = (error as { code: unknown }).code;
        return typeof c === 'string' ? c : null;
    }
    return null;
}

function friendlyAuthError(error: unknown): string {
    const code = getErrorCode(error);
    switch (code) {
        case 'auth/email-already-in-use':
            return 'That email is already in use. Try signing in, or use a different email.';
        case 'auth/invalid-email':
            return 'That email does not look valid. Check for typos and try again.';
        case 'auth/weak-password':
            return 'Use a stronger password (for example at least 6 characters).';
        case 'auth/user-not-found':
        case 'auth/wrong-password':
        case 'auth/invalid-credential':
            return 'Wrong email or password. Please try again.';
        case 'auth/too-many-requests':
            return 'Too many sign-in attempts. Wait a few minutes, then try again.';
        case 'auth/network-request-failed':
            return 'We could not reach the server. Check your internet connection.';
        case 'auth/user-disabled':
            return 'This account has been disabled. Contact support.';
        default:
            return 'Something went wrong while signing you in. Please try again.';
    }
}

function friendlyPasswordResetError(error: unknown): string {
    const code = getErrorCode(error);
    switch (code) {
        case 'auth/invalid-email':
            return 'That email does not look valid. Check for typos and try again.';
        case 'auth/missing-email':
            return 'Enter the email address for your account.';
        case 'auth/too-many-requests':
            return 'Too many reset attempts. Wait a few minutes, then try again.';
        case 'auth/network-request-failed':
            return 'We could not reach the server. Check your internet connection.';
        case 'auth/user-disabled':
            return 'This account has been disabled. Contact support.';
        default:
            return 'We could not send a reset email. Please try again.';
    }
}

function friendlyProfileError(error: unknown): string {
    const code = getErrorCode(error);
    if (code === 'auth/requires-recent-login') {
        return 'For security, sign out and sign back in, then update your name.';
    }
    return 'We could not save your name. Please try again.';
}

function friendlyFirestoreError(error: unknown, fallback: string): string {
    const code = getErrorCode(error);
    switch (code) {
        case 'permission-denied':
            return "You don't have permission to do that. Ask your company admin, or check your internet connection.";
        case 'unavailable':
            return 'The service is busy right now. Please try again in a moment.';
        case 'failed-precondition':
        case 'aborted':
            return 'That action could not finish. Please try again.';
        case 'not-found':
            return 'We could not find that information. It may have been removed.';
        default:
            return fallback;
    }
}

function friendlyInviteAcceptError(error: unknown): string {
    const code = getErrorCode(error);
    if (
        code === 'permission-denied' ||
        code === 'unavailable' ||
        code === 'failed-precondition' ||
        code === 'aborted'
    ) {
        return friendlyFirestoreError(
            error,
            'Could not join with this invitation.'
        );
    }
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return 'Could not join with this invitation. Check the ID and try again.';
}

// =========================
// Company/member data models
// =========================

type EmployeeStatus = 'active' | 'suspended' | 'offboarded';

type CompanyTeam = {
    id: string;
    name: string;
};

type CompanyEmployee = {
    uid: string;
    role: string;
    invitedForName: string;
    email?: string | null;
    displayName?: string | null;
    status?: EmployeeStatus;
    teamIds?: string[];
    holidayDays?: number | null;
};

type HolidayRequestStatus = 'pending' | 'approved' | 'rejected';

type HolidayRequestRecord = {
    id: string;
    requesterUid: string;
    requesterLabel: string;
    days: number;
    status: HolidayRequestStatus;
    createdAt: unknown;
    resolvedAt: unknown;
};

function normalizeEmployee(raw: unknown): CompanyEmployee | null {
    if (!raw || typeof raw !== 'object' || !('uid' in raw)) {
        return null;
    }
    const o = raw as Record<string, unknown>;
    const uid = typeof o.uid === 'string' ? o.uid : '';
    if (!uid) {
        return null;
    }
    const role = typeof o.role === 'string' ? o.role : 'member';
    const invitedForName =
        typeof o.invitedForName === 'string' ? o.invitedForName : 'Member';
    const email = typeof o.email === 'string' ? o.email : null;
    const displayName =
        typeof o.displayName === 'string' ? o.displayName : null;
    const statusRaw = o.status;
    const status: EmployeeStatus =
        statusRaw === 'suspended' || statusRaw === 'offboarded'
            ? statusRaw
            : 'active';
    let teamIds: string[] = [];
    if (Array.isArray(o.teamIds)) {
        teamIds = o.teamIds.filter(
            (id): id is string => typeof id === 'string'
        );
    }
    const holidayRaw = o.holidayDays;
    const holidayDays =
        typeof holidayRaw === 'number' && Number.isFinite(holidayRaw)
            ? Math.max(0, Math.floor(holidayRaw))
            : null;
    return {
        uid,
        role,
        invitedForName,
        email,
        displayName,
        status,
        teamIds,
        holidayDays,
    };
}

function normalizeEmployeeList(data: unknown): CompanyEmployee[] {
    if (!Array.isArray(data)) {
        return [];
    }
    const out: CompanyEmployee[] = [];
    for (const item of data) {
        const e = normalizeEmployee(item);
        if (e) {
            out.push(e);
        }
    }
    return out;
}

function normalizeTeams(data: unknown): CompanyTeam[] {
    if (!Array.isArray(data)) {
        return [];
    }
    const out: CompanyTeam[] = [];
    for (const item of data) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const o = item as Record<string, unknown>;
        const id = typeof o.id === 'string' ? o.id : '';
        const name = typeof o.name === 'string' ? o.name.trim() : '';
        if (id && name) {
            out.push({ id, name });
        }
    }
    return out;
}

function memberDisplayName(e: CompanyEmployee): string {
    const d = e.displayName?.trim();
    if (d) {
        return d;
    }
    return e.invitedForName?.trim() || 'Member';
}

function canManageMembers(
    isOwner: boolean,
    employeeRoleRaw: string,
    entries: InviteRoleEntry[]
): boolean {
    if (isOwner) {
        return true;
    }
    return canUserSendInvitations(false, employeeRoleRaw, entries);
}

function teamNameById(teams: CompanyTeam[], id: string): string {
    return teams.find((t) => t.id === id)?.name ?? id;
}

let dashboardListenersCleanup: (() => void) | null = null;

function cleanupDashboardListeners(): void {
    if (dashboardListenersCleanup) {
        dashboardListenersCleanup();
        dashboardListenersCleanup = null;
    }
}

async function appendAuditEvent(
    companyId: string,
    patch: {
        actorUid: string;
        actorLabel: string;
        action: string;
        summary: string;
        detail?: string;
    }
): Promise<void> {
    await addDoc(collection(db, 'companies', companyId, 'auditLog'), {
        ...patch,
        createdAt: serverTimestamp(),
    });
}

function auditTimestampLabel(value: unknown): string {
    if (value instanceof Timestamp) {
        return value.toDate().toLocaleString();
    }
    return '—';
}

function statusDisplayLabel(s: EmployeeStatus): string {
    if (s === 'offboarded') {
        return 'Offboarded';
    }
    if (s === 'suspended') {
        return 'Suspended';
    }
    return 'Active';
}

function holidayStatusLabel(days: number | null | undefined): string {
    if (typeof days !== 'number' || !Number.isFinite(days)) {
        return 'Not set';
    }
    const whole = Math.max(0, Math.floor(days));
    return whole === 1 ? '1 day left' : `${whole} days left`;
}

function normalizeHolidayRequest(
    id: string,
    raw: unknown
): HolidayRequestRecord | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const o = raw as Record<string, unknown>;
    const requesterUid =
        typeof o.requesterUid === 'string' ? o.requesterUid : '';
    if (!requesterUid) {
        return null;
    }
    const requesterLabel =
        typeof o.requesterLabel === 'string' && o.requesterLabel.trim()
            ? o.requesterLabel.trim()
            : 'Member';
    const daysRaw = o.days;
    const days =
        typeof daysRaw === 'number' && Number.isFinite(daysRaw)
            ? Math.max(1, Math.floor(daysRaw))
            : 0;
    if (days <= 0) {
        return null;
    }
    const statusRaw = o.status;
    const status: HolidayRequestStatus =
        statusRaw === 'approved' || statusRaw === 'rejected'
            ? statusRaw
            : 'pending';
    return {
        id,
        requesterUid,
        requesterLabel,
        days,
        status,
        createdAt: o.createdAt,
        resolvedAt: o.resolvedAt,
    };
}

function roleOptionsForMemberEdit(
    emp: CompanyEmployee,
    inviteEntries: InviteRoleEntry[],
    ownerUid: string
): InviteRoleEntry[] {
    if (emp.uid === ownerUid) {
        return [{ name: 'owner', highUp: true }];
    }
    const names = new Set(
        inviteEntries.map((e) => e.name.trim().toLowerCase())
    );
    const current = emp.role?.trim() ?? '';
    if (current && !names.has(current.toLowerCase())) {
        return [...inviteEntries, { name: current, highUp: false }];
    }
    return inviteEntries;
}

function teamIdsEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
        return false;
    }
    const sa = [...a].sort();
    const sb = [...b].sort();
    return sa.every((v, i) => v === sb[i]);
}

async function resolveUserCompanyId(uid: string): Promise<string | null> {
    const ownerQ = query(
        collection(db, 'companies'),
        where('ownerUid', '==', uid),
        limit(1)
    );
    const ownerSnap = await getDocs(ownerQ);
    if (!ownerSnap.empty) {
        return ownerSnap.docs[0].id;
    }
    const memberQ = query(
        collection(db, 'companies'),
        where('employeeUids', 'array-contains', uid),
        limit(1)
    );
    const memberSnap = await getDocs(memberQ);
    if (!memberSnap.empty) {
        return memberSnap.docs[0].id;
    }
    return null;
}

async function getUserCompanySummary(uid: string): Promise<{
    companyId: string;
    companyName: string;
    role: string;
    roleRaw: string;
    inviteRoles: InviteRoleEntry[];
    isOwner: boolean;
    canSendInvites: boolean;
    canManageMembers: boolean;
    employees: CompanyEmployee[];
    teams: CompanyTeam[];
    ownerUid: string;
} | null> {
    const companyId = await resolveUserCompanyId(uid);
    if (!companyId) {
        return null;
    }
    const snap = await getDoc(doc(db, 'companies', companyId));
    if (!snap.exists()) {
        return null;
    }
    const data = snap.data();
    const companyName =
        typeof data.name === 'string' && data.name.trim()
            ? data.name.trim()
            : 'your company';
    const employees = normalizeEmployeeList(data.employees);
    const teams = normalizeTeams(data.teams);
    const ownerUid = typeof data.ownerUid === 'string' ? data.ownerUid : '';
    const entry = employees.find((e) => e.uid === uid);
    let roleRaw = entry?.role?.trim() ?? '';
    if (!roleRaw && data.ownerUid === uid) {
        roleRaw = 'owner';
    }
    if (!roleRaw) {
        roleRaw = 'member';
    }
    const inviteRoles = normalizeInviteRoleEntries(data.inviteRoles);
    const isOwner = data.ownerUid === uid;
    const canSendInvites = canUserSendInvitations(
        isOwner,
        roleRaw,
        inviteRoles
    );
    const canManageMembersFlag = canManageMembers(
        isOwner,
        roleRaw,
        inviteRoles
    );
    return {
        companyId,
        companyName,
        role: formatRoleForDisplay(roleRaw),
        roleRaw,
        inviteRoles,
        isOwner,
        canSendInvites,
        canManageMembers: canManageMembersFlag,
        employees,
        teams,
        ownerUid,
    };
}

async function acceptFirestoreInviteAndJoinCompany(
    user: User,
    inviteId: string
): Promise<void> {
    const trimmedId = inviteId.trim();
    if (!trimmedId) {
        throw new Error(
            'Paste the full invitation ID you were given, then press Enter.'
        );
    }

    const inviteRef = doc(db, INVITES_COLLECTION, trimmedId);

    let postJoinAudit: { companyId: string; role: string } | null = null;

    await runTransaction(db, async (transaction) => {
        const inviteSnap = await transaction.get(inviteRef);
        if (!inviteSnap.exists()) {
            throw new Error(
                'We could not find that invitation. Check the ID for typos, or ask your admin to send a new invite.'
            );
        }

        const inv = inviteSnap.data();
        if (inv.used === true) {
            throw new Error(
                'This invitation was already used. Ask your admin for a fresh invitation.'
            );
        }

        const expiresAt = inv.expiresAt as Timestamp | undefined;
        if (!expiresAt) {
            throw new Error(
                'This invitation is out of date. Ask your admin to create a new invitation.'
            );
        }
        if (expiresAt.toMillis() < Date.now()) {
            throw new Error(
                `This invitation has expired (invitations last ${INVITE_EXPIRY_DAYS} days). Ask your admin for a new one.`
            );
        }

        const companyId = inv.companyId;
        const role = inv.role;
        const inviteeName = inv.inviteeName;
        if (
            typeof companyId !== 'string' ||
            !companyId ||
            typeof role !== 'string' ||
            !role ||
            typeof inviteeName !== 'string' ||
            !inviteeName
        ) {
            throw new Error(
                'This invitation is damaged or incomplete. Ask your admin to send a new one.'
            );
        }

        const companyRef = doc(db, 'companies', companyId);
        const companySnap = await transaction.get(companyRef);
        if (!companySnap.exists()) {
            throw new Error(
                'That company no longer exists. Ask your admin for help.'
            );
        }

        const data = companySnap.data();
        const employees = (data.employees ?? []) as CompanyEmployee[];
        const employeeUids = (data.employeeUids ?? []) as string[];

        if (employeeUids.includes(user.uid)) {
            throw new Error(
                'You are already part of this company. Continue to the dashboard by signing in.'
            );
        }

        const newMember: CompanyEmployee = {
            uid: user.uid,
            role,
            invitedForName: inviteeName,
            email: user.email ?? null,
            displayName: user.displayName?.trim() || null,
            status: 'active',
            teamIds: [],
            holidayDays: null,
        };

        transaction.update(companyRef, {
            employees: [...employees, newMember],
            employeeUids: [...employeeUids, user.uid],
        });

        transaction.update(inviteRef, {
            used: true,
            usedByUid: user.uid,
            usedAt: serverTimestamp(),
        });

        postJoinAudit = { companyId, role };
    });

    const actorLabel =
        user.displayName?.trim() || user.email?.split('@')[0] || 'Someone';
    const joinedName =
        user.displayName?.trim() || user.email?.split('@')[0] || 'New member';
    if (postJoinAudit) {
        try {
            await appendAuditEvent(postJoinAudit.companyId, {
                actorUid: user.uid,
                actorLabel,
                action: 'member_joined',
                summary: `${joinedName} joined the company`,
                detail: `Accepted invitation; role: ${postJoinAudit.role}`,
            });
        } catch {
            /* audit is best-effort */
        }
    }
}

// =========================
// Session + onboarding state
// =========================

const PENDING_PROFILE_KEY = 'manageme_pending_profile';
const ONBOARDING_STEP_KEY = 'manageme_onboarding_step';
const ONBOARDING_INVITATION_KEY = 'manageme_onboarding_invitation';

type OnboardingStep = 'profile' | 'invite' | 'company';

const clearOnboardingSession = (): void => {
    sessionStorage.removeItem(PENDING_PROFILE_KEY);
    sessionStorage.removeItem(ONBOARDING_STEP_KEY);
    sessionStorage.removeItem(ONBOARDING_INVITATION_KEY);
};

let settingsOutsideClickHandler: (() => void) | undefined;

const detachSettingsOutsideClick = (): void => {
    if (settingsOutsideClickHandler) {
        document.removeEventListener('click', settingsOutsideClickHandler);
        settingsOutsideClickHandler = undefined;
    }
};

const appRoot = document.getElementById('app');

if (!appRoot) {
    throw new Error('App root element not found.');
}

const removeUpdateToast = (): void => {
    document.getElementById('app-update-toast')?.remove();
};

const showUpdateToast = (payload: AppUpdatePayload): void => {
    removeUpdateToast();
    const releaseLabel = payload.releaseName?.trim() || 'New version';
    const notes = payload.releaseNotes?.trim() || '';
    const notePreview =
        notes.length > 220 ? `${notes.slice(0, 220)}...` : notes;
    const toast = document.createElement('section');
    toast.id = 'app-update-toast';
    toast.className = 'app-update-toast modal-card';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = `
        <h3 class="modal-title app-update-toast-title">Update ready</h3>
        <p class="modal-subtitle app-update-toast-subtitle">${escapeHtml(releaseLabel)} has been downloaded.</p>
        ${
            notePreview
                ? `<p class="dash-section-hint app-update-toast-notes">${escapeHtml(notePreview)}</p>`
                : ''
        }
        <div class="app-update-toast-actions">
            <button type="button" id="app-update-restart-btn" class="submit-btn submit-btn--compact">Restart now</button>
            <button type="button" id="app-update-later-btn" class="modal-close-btn app-update-later-btn">Later</button>
        </div>
    `;
    document.body.appendChild(toast);
    const restartBtn = document.getElementById(
        'app-update-restart-btn'
    ) as HTMLButtonElement | null;
    const laterBtn = document.getElementById(
        'app-update-later-btn'
    ) as HTMLButtonElement | null;
    restartBtn?.addEventListener('click', () => {
        window.manageMeDesktop?.installUpdate();
    });
    laterBtn?.addEventListener('click', () => {
        removeUpdateToast();
    });
};

window.manageMeDesktop?.onUpdateReady((payload) => {
    showUpdateToast(payload);
});

// =========================
// Authentication screen
// =========================

const renderAuth = (): void => {
    cleanupDashboardListeners();
    detachSettingsOutsideClick();
    appRoot.innerHTML = `
    <main class="auth-page">
        <section class="auth-card">
            <h1 class="app-title">ManageMe</h1>
            <p id="auth-tagline" class="auth-subtitle">Your company manager—people, roles, and structure in one place.</p>
            <p id="auth-reset-hint" class="auth-reset-hint" hidden>Enter your email and we'll send a link to reset your password. Check your inbox and spam folder.</p>

            ${themeToggleStripHtml()}

            <div id="auth-mode-toggle-wrap">
                <div class="auth-toggle" role="tablist" aria-label="Authentication mode">
                    <button id="signin-toggle" class="toggle-btn active" type="button" role="tab" aria-selected="true">
                        Sign In
                    </button>
                    <button id="signup-toggle" class="toggle-btn" type="button" role="tab" aria-selected="false">
                        Sign Up
                    </button>
                </div>
            </div>

            <form id="auth-form" class="auth-form">
                <label class="form-label" for="email-input">Email</label>
                <input id="email-input" class="form-input" type="email" autocomplete="email" placeholder="you@example.com" required />

                <div id="password-field-wrap">
                    <label class="form-label" for="password-input">Password</label>
                    <input id="password-input" class="form-input" type="password" autocomplete="current-password" placeholder="Enter your password" required />
                </div>

                <div id="forgot-password-row" class="auth-forgot-row">
                    <button type="button" id="forgot-password-btn" class="auth-text-link">
                        Forgot password?
                    </button>
                </div>

                <button id="submit-btn" class="submit-btn" type="submit">Sign In</button>
            </form>

            <p id="auth-message" class="auth-message" aria-live="polite"></p>
            <div class="auth-update-row">
                <button type="button" id="auth-check-updates-btn" class="auth-text-link">
                    Check for updates
                </button>
            </div>
            <button type="button" id="back-from-reset-btn" class="auth-text-link auth-back-from-reset" hidden>
                Back to sign in
            </button>
        </section>
    </main>
`;

    const authTagline = document.getElementById(
        'auth-tagline'
    ) as HTMLParagraphElement;
    const authResetHint = document.getElementById(
        'auth-reset-hint'
    ) as HTMLParagraphElement;
    const authModeToggleWrap = document.getElementById(
        'auth-mode-toggle-wrap'
    ) as HTMLDivElement;
    const signInToggle = document.getElementById(
        'signin-toggle'
    ) as HTMLButtonElement;
    const signUpToggle = document.getElementById(
        'signup-toggle'
    ) as HTMLButtonElement;
    const authForm = document.getElementById('auth-form') as HTMLFormElement;
    const passwordFieldWrap = document.getElementById(
        'password-field-wrap'
    ) as HTMLDivElement;
    const forgotPasswordRow = document.getElementById(
        'forgot-password-row'
    ) as HTMLDivElement;
    const forgotPasswordBtn = document.getElementById(
        'forgot-password-btn'
    ) as HTMLButtonElement;
    const backFromResetBtn = document.getElementById(
        'back-from-reset-btn'
    ) as HTMLButtonElement;
    const emailInput = document.getElementById(
        'email-input'
    ) as HTMLInputElement;
    const passwordInput = document.getElementById(
        'password-input'
    ) as HTMLInputElement;
    const submitButton = document.getElementById(
        'submit-btn'
    ) as HTMLButtonElement;
    const authMessage = document.getElementById(
        'auth-message'
    ) as HTMLParagraphElement;
    const checkUpdatesBtn = document.getElementById(
        'auth-check-updates-btn'
    ) as HTMLButtonElement;

    let currentMode: AuthMode = 'signin';
    let showPasswordReset = false;

    const updateIdleSubmitLabel = (): void => {
        if (showPasswordReset) {
            submitButton.textContent = 'Send reset link';
            return;
        }
        submitButton.textContent =
            currentMode === 'signin' ? 'Sign In' : 'Sign Up';
    };

    const paintAuthChrome = (): void => {
        const isSignIn = currentMode === 'signin';

        authModeToggleWrap.hidden = showPasswordReset;
        authTagline.hidden = showPasswordReset;
        authResetHint.hidden = !showPasswordReset;
        passwordFieldWrap.hidden = showPasswordReset;
        forgotPasswordRow.hidden = showPasswordReset || !isSignIn;
        backFromResetBtn.hidden = !showPasswordReset;
        passwordInput.required = !showPasswordReset;

        if (!showPasswordReset) {
            passwordInput.autocomplete = isSignIn
                ? 'current-password'
                : 'new-password';
        }
    };

    const setMode = (mode: AuthMode): void => {
        showPasswordReset = false;
        currentMode = mode;
        const isSignIn = mode === 'signin';

        signInToggle.classList.toggle('active', isSignIn);
        signUpToggle.classList.toggle('active', !isSignIn);
        signInToggle.setAttribute('aria-selected', String(isSignIn));
        signUpToggle.setAttribute('aria-selected', String(!isSignIn));

        authMessage.textContent = '';
        authMessage.classList.remove('success', 'error');
        paintAuthChrome();
        updateIdleSubmitLabel();
    };

    const enterPasswordReset = (): void => {
        showPasswordReset = true;
        currentMode = 'signin';
        signInToggle.classList.add('active');
        signUpToggle.classList.remove('active');
        signInToggle.setAttribute('aria-selected', 'true');
        signUpToggle.setAttribute('aria-selected', 'false');
        passwordInput.value = '';
        authMessage.textContent = '';
        authMessage.classList.remove('success', 'error');
        paintAuthChrome();
        updateIdleSubmitLabel();
        emailInput.focus();
    };

    const leavePasswordReset = (): void => {
        setMode('signin');
    };

    const setStatus = (message: string, type: 'success' | 'error'): void => {
        authMessage.textContent = message;
        authMessage.classList.remove('success', 'error');
        authMessage.classList.add(type);
    };

    const setLoading = (isLoading: boolean): void => {
        submitButton.disabled = isLoading;
        forgotPasswordBtn.disabled = isLoading;
        backFromResetBtn.disabled = isLoading;
        checkUpdatesBtn.disabled = isLoading;
        if (isLoading) {
            submitButton.textContent = showPasswordReset
                ? 'Sending...'
                : currentMode === 'signin'
                  ? 'Signing In...'
                  : 'Signing Up...';
            return;
        }
        updateIdleSubmitLabel();
    };

    signInToggle.addEventListener('click', () => setMode('signin'));
    signUpToggle.addEventListener('click', () => setMode('signup'));
    forgotPasswordBtn.addEventListener('click', () => enterPasswordReset());
    backFromResetBtn.addEventListener('click', () => leavePasswordReset());

    checkUpdatesBtn.addEventListener('click', async () => {
        const desktop = window.manageMeDesktop;
        if (!desktop?.checkForUpdates) {
            setStatus(
                'Update checks are only available in the desktop app.',
                'error'
            );
            return;
        }
        const prevLabel = checkUpdatesBtn.textContent;
        checkUpdatesBtn.disabled = true;
        checkUpdatesBtn.textContent = 'Checking...';
        authMessage.textContent = '';
        authMessage.classList.remove('success', 'error');
        try {
            const res = await desktop.checkForUpdates();
            if (!res.ok && res.kind === 'not_packaged') {
                setStatus(
                    'Updates are available only in the installed desktop app.',
                    'error'
                );
                return;
            }
            if (!res.ok && res.kind === 'error') {
                setStatus(
                    res.message.trim() ||
                        'Could not check for updates. Try again later.',
                    'error'
                );
                return;
            }
            if (res.ok && res.kind === 'no_update') {
                setStatus("You're on the latest version.", 'success');
                return;
            }
            if (res.ok && res.kind === 'update_available') {
                setStatus(
                    "A new version is available. It's downloading in the background—we'll let you know when it's ready to install.",
                    'success'
                );
            }
        } finally {
            checkUpdatesBtn.disabled = false;
            checkUpdatesBtn.textContent = prevLabel ?? 'Check for updates';
        }
    });

    authForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        const email = emailInput.value.trim();
        const password = passwordInput.value.trim();

        if (showPasswordReset) {
            if (!email) {
                setStatus('Enter the email address for your account.', 'error');
                return;
            }
            setLoading(true);
            authMessage.textContent = '';
            authMessage.classList.remove('success', 'error');
            try {
                await sendPasswordResetEmail(auth, email);
                setStatus(
                    'If an account exists for that email, we sent password reset instructions. Check your inbox and spam folder.',
                    'success'
                );
            } catch (error) {
                if (getErrorCode(error) === 'auth/user-not-found') {
                    setStatus(
                        'If an account exists for that email, we sent password reset instructions. Check your inbox and spam folder.',
                        'success'
                    );
                } else {
                    setStatus(friendlyPasswordResetError(error), 'error');
                }
            } finally {
                setLoading(false);
            }
            return;
        }

        if (!email || !password) {
            setStatus('Please provide both email and password.', 'error');
            return;
        }

        setLoading(true);
        authMessage.textContent = '';
        authMessage.classList.remove('success', 'error');

        try {
            if (currentMode === 'signin') {
                sessionStorage.removeItem(PENDING_PROFILE_KEY);
                await signInWithEmailAndPassword(auth, email, password);
            } else {
                sessionStorage.setItem(PENDING_PROFILE_KEY, '1');
                try {
                    await createUserWithEmailAndPassword(auth, email, password);
                } catch (createError) {
                    sessionStorage.removeItem(PENDING_PROFILE_KEY);
                    throw createError;
                }
            }
        } catch (error) {
            setStatus(friendlyAuthError(error), 'error');
        } finally {
            setLoading(false);
        }
    });

    syncThemePreferenceUi();
};

const getOnboardingStep = (): OnboardingStep => {
    const raw = sessionStorage.getItem(ONBOARDING_STEP_KEY);
    if (raw === 'invite' || raw === 'company') {
        return raw;
    }
    return 'profile';
};

const setOnboardingStep = (step: OnboardingStep): void => {
    sessionStorage.setItem(ONBOARDING_STEP_KEY, step);
};

// =========================
// Onboarding flow screens
// =========================

const tryAcceptInvitationFromOnboarding = async (
    rawToken: string,
    inviteMessage: HTMLParagraphElement
): Promise<void> => {
    const user = auth.currentUser;
    if (!user) {
        inviteMessage.textContent = 'Session expired. Please sign in again.';
        inviteMessage.classList.remove('success');
        inviteMessage.classList.add('error');
        return;
    }

    const inviteId = rawToken.trim();
    if (!inviteId) {
        inviteMessage.textContent = 'Paste an invitation ID first.';
        inviteMessage.classList.remove('success');
        inviteMessage.classList.add('error');
        return;
    }

    inviteMessage.textContent = 'Joining company...';
    inviteMessage.classList.remove('success', 'error');

    try {
        await acceptFirestoreInviteAndJoinCompany(user, inviteId);
        clearOnboardingSession();
        await renderDashboard(user);
    } catch (error) {
        inviteMessage.textContent = friendlyInviteAcceptError(error);
        inviteMessage.classList.add('error');
    }
};

const renderOnboarding = (): void => {
    const step = getOnboardingStep();
    if (step === 'invite') {
        renderOnboardingInvite();
        return;
    }
    if (step === 'company') {
        renderOnboardingCompany();
        return;
    }
    renderOnboardingProfile();
};

const renderOnboardingProfile = (): void => {
    cleanupDashboardListeners();
    detachSettingsOutsideClick();
    setOnboardingStep('profile');
    appRoot.innerHTML = `
    <main class="auth-page">
        <section class="auth-card onboarding-card">
            <h1 class="app-title">Welcome to ManageMe</h1>
            <p class="auth-subtitle">Set up your profile for this company manager. What should we call you?</p>
            ${themeToggleStripHtml()}

            <form id="profile-form" class="auth-form">
                <label class="form-label" for="display-name-input">Display name</label>
                <input id="display-name-input" class="form-input" type="text" autocomplete="name" placeholder="Your name" required maxlength="80" />

                <button id="profile-submit-btn" class="submit-btn" type="submit">Continue</button>
            </form>

            <p id="profile-message" class="auth-message" aria-live="polite"></p>
        </section>
    </main>
`;

    const profileForm = document.getElementById(
        'profile-form'
    ) as HTMLFormElement;
    const displayNameInput = document.getElementById(
        'display-name-input'
    ) as HTMLInputElement;
    const profileSubmitBtn = document.getElementById(
        'profile-submit-btn'
    ) as HTMLButtonElement;
    const profileMessage = document.getElementById(
        'profile-message'
    ) as HTMLParagraphElement;

    profileForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const name = displayNameInput.value.trim();
        if (!name) {
            profileMessage.textContent = 'Please enter a display name.';
            profileMessage.classList.remove('success');
            profileMessage.classList.add('error');
            return;
        }

        const user = auth.currentUser;
        if (!user) {
            profileMessage.textContent =
                'Session expired. Please sign in again.';
            profileMessage.classList.remove('success');
            profileMessage.classList.add('error');
            return;
        }

        profileSubmitBtn.disabled = true;
        profileSubmitBtn.textContent = 'Saving...';
        profileMessage.textContent = '';
        profileMessage.classList.remove('success', 'error');

        try {
            await updateProfile(user, { displayName: name });
            setOnboardingStep('invite');
            renderOnboardingInvite();
        } catch (error) {
            profileMessage.textContent = friendlyProfileError(error);
            profileMessage.classList.add('error');
        } finally {
            profileSubmitBtn.disabled = false;
            profileSubmitBtn.textContent = 'Continue';
        }
    });

    syncThemePreferenceUi();
};

const renderOnboardingInvite = (): void => {
    cleanupDashboardListeners();
    detachSettingsOutsideClick();
    setOnboardingStep('invite');
    appRoot.innerHTML = `
    <main class="auth-page">
        <section class="auth-card onboarding-card onboarding-card--wide">
            <h1 class="app-title">Join or create a company</h1>
            <p class="auth-subtitle">ManageMe is built to run a company together. Have an invite? Paste the <strong>invitation ID</strong>, then press <strong>Enter</strong> (invitations expire after <strong>${INVITE_EXPIRY_DAYS} days</strong>). Or start a new company workspace below.</p>
            ${themeToggleStripHtml()}

            <div class="auth-form">
                <label class="form-label" for="invitation-id-input">Invitation ID</label>
                <input id="invitation-id-input" class="form-input" type="text" autocomplete="off" placeholder="Invite document ID, then press Enter" />

                <button type="button" id="make-company-btn" class="submit-btn submit-btn--secondary">Make a company</button>
            </div>

            <p id="invite-message" class="auth-message" aria-live="polite"></p>
        </section>
    </main>
`;

    const invitationInput = document.getElementById(
        'invitation-id-input'
    ) as HTMLInputElement;
    const makeCompanyBtn = document.getElementById(
        'make-company-btn'
    ) as HTMLButtonElement;
    const inviteMessage = document.getElementById(
        'invite-message'
    ) as HTMLParagraphElement;

    invitationInput.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') {
            return;
        }
        e.preventDefault();
        void tryAcceptInvitationFromOnboarding(
            invitationInput.value,
            inviteMessage
        );
    });

    makeCompanyBtn.addEventListener('click', () => {
        const invitationId = invitationInput.value.trim();
        sessionStorage.setItem(ONBOARDING_INVITATION_KEY, invitationId);
        setOnboardingStep('company');
        inviteMessage.textContent = '';
        inviteMessage.classList.remove('error');
        renderOnboardingCompany();
    });

    syncThemePreferenceUi();
};

const renderOnboardingCompany = (): void => {
    cleanupDashboardListeners();
    detachSettingsOutsideClick();
    setOnboardingStep('company');

    appRoot.innerHTML = `
    <main class="auth-page">
        <section class="auth-card onboarding-card onboarding-card--wide">
            <h1 class="app-title">Your company</h1>
            <p class="auth-subtitle">Tell us about the organization you will manage in ManageMe.</p>
            ${themeToggleStripHtml()}

            <form id="company-form" class="auth-form">
                <label class="form-label" for="company-name-input">Company name</label>
                <input id="company-name-input" class="form-input" type="text" autocomplete="organization" placeholder="Acme Inc." required maxlength="120" />

                <label class="form-label" for="company-description-input">Description</label>
                <textarea id="company-description-input" class="form-input form-textarea" rows="3" placeholder="What does your company do?" maxlength="2000"></textarea>

                <label class="form-label" for="company-industry-input">Industry <span class="label-hint">(optional)</span></label>
                <input id="company-industry-input" class="form-input" type="text" autocomplete="off" placeholder="e.g. Software, Retail" maxlength="80" />

                <button id="company-submit-btn" class="submit-btn" type="submit">Create company</button>
            </form>

            <p id="company-message" class="auth-message" aria-live="polite"></p>
        </section>
    </main>
`;

    const companyForm = document.getElementById(
        'company-form'
    ) as HTMLFormElement;
    const companyNameInput = document.getElementById(
        'company-name-input'
    ) as HTMLInputElement;
    const companyDescriptionInput = document.getElementById(
        'company-description-input'
    ) as HTMLTextAreaElement;
    const companyIndustryInput = document.getElementById(
        'company-industry-input'
    ) as HTMLInputElement;
    const companySubmitBtn = document.getElementById(
        'company-submit-btn'
    ) as HTMLButtonElement;
    const companyMessage = document.getElementById(
        'company-message'
    ) as HTMLParagraphElement;

    companyForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        const user = auth.currentUser;
        if (!user) {
            companyMessage.textContent =
                'Session expired. Please sign in again.';
            companyMessage.classList.remove('success');
            companyMessage.classList.add('error');
            return;
        }

        const name = companyNameInput.value.trim();
        if (!name) {
            companyMessage.textContent = 'Please enter a company name.';
            companyMessage.classList.add('error');
            return;
        }

        const description = companyDescriptionInput.value.trim();
        const industry = companyIndustryInput.value.trim();
        const invitationId =
            sessionStorage.getItem(ONBOARDING_INVITATION_KEY) ?? '';

        companySubmitBtn.disabled = true;
        companySubmitBtn.textContent = 'Creating...';
        companyMessage.textContent = '';
        companyMessage.classList.remove('success', 'error');

        try {
            const companyRef = doc(collection(db, 'companies'));
            const ownerLabel =
                user.displayName?.trim() ||
                user.email?.split('@')[0] ||
                'Owner';
            await setDoc(companyRef, {
                ownerUid: user.uid,
                name,
                description: description || null,
                industry: industry || null,
                invitationId: invitationId || null,
                createdAt: serverTimestamp(),
                teams: [],
                employees: [
                    {
                        uid: user.uid,
                        role: 'owner',
                        invitedForName: ownerLabel,
                        email: user.email ?? null,
                        displayName: user.displayName?.trim() || null,
                        status: 'active',
                        teamIds: [],
                        holidayDays: null,
                    },
                ],
                employeeUids: [user.uid],
                inviteRoles: defaultInviteRoleEntries(),
            });

            try {
                const welcomeBody = buildWelcomeCompanyNewsBody(name);
                if (welcomeBody.length <= NEWS_BODY_MAX_LENGTH) {
                    await addDoc(
                        collection(
                            db,
                            'companies',
                            companyRef.id,
                            COMPANY_NEWS_SUBCOLLECTION
                        ),
                        {
                            authorUid: user.uid,
                            authorLabel: WELCOME_COMPANY_NEWS_AUTHOR,
                            body: welcomeBody,
                            createdAt: serverTimestamp(),
                        }
                    );
                }
            } catch {
                /* best-effort: company still works without the welcome post */
            }

            try {
                await appendAuditEvent(companyRef.id, {
                    actorUid: user.uid,
                    actorLabel: ownerLabel,
                    action: 'company_created',
                    summary: `Company "${name}" was created`,
                });
            } catch {
                /* best-effort */
            }

            clearOnboardingSession();
            const refreshed = auth.currentUser;
            if (refreshed) {
                await renderDashboard(refreshed);
            }
        } catch (error) {
            companyMessage.textContent = friendlyFirestoreError(
                error,
                'We could not create your company. Please try again.'
            );
            companyMessage.classList.add('error');
        } finally {
            companySubmitBtn.disabled = false;
            companySubmitBtn.textContent = 'Create company';
        }
    });

    syncThemePreferenceUi();
};

// =========================
// Main dashboard
// =========================

const renderDashboard = async (user: User): Promise<void> => {
    cleanupDashboardListeners();
    detachSettingsOutsideClick();
    const greetingName =
        user.displayName?.trim() || user.email?.split('@')[0] || 'there';

    const companyContext = await getUserCompanySummary(user.uid);
    const membershipHtml = companyContext
        ? `<p class="dash-membership">You're now a part of <strong>${escapeHtml(
              companyContext.companyName
          )}</strong> as <strong>${escapeHtml(companyContext.role)}</strong>.</p>`
        : '';

    const companyNewsSectionHtml = companyContext
        ? `
                <section class="dash-section">
                    <h3 class="dash-section-heading">Company news</h3>
                    <p class="dash-section-hint">Updates everyone in your company can read. Anyone in the company can post a message.</p>
                    <form id="news-post-form" class="news-post-form">
                        <label class="sr-only" for="news-body-input">News message</label>
                        <textarea id="news-body-input" class="form-input form-textarea news-body-input" rows="3" maxlength="${NEWS_BODY_MAX_LENGTH}" placeholder="Share an update with the company…"></textarea>
                        <button type="submit" id="news-post-btn" class="submit-btn submit-btn--compact">Post</button>
                    </form>
                    <p id="news-post-message" class="auth-message dash-role-message" aria-live="polite"></p>
                    <div id="company-news-list" class="company-news-list" aria-live="polite"></div>
                </section>
            `
        : '';

    const meetingsSectionHtml = companyContext
        ? `
                <section class="dash-section">
                    <h3 class="dash-section-heading">Meetings</h3>
                    <p class="dash-section-hint">Schedule meetings everyone in the company can see. Times use your device timezone.</p>
                    <form id="meeting-create-form" class="meeting-create-form">
                        <label class="form-label" for="meeting-title-input">Title</label>
                        <input id="meeting-title-input" class="form-input" type="text" maxlength="${MEETING_TITLE_MAX_LENGTH}" placeholder="e.g. Weekly sync" required autocomplete="off" />
                        <div class="meeting-datetime-row">
                            <div>
                                <label class="form-label" for="meeting-start-input">Starts</label>
                                <input id="meeting-start-input" class="form-input" type="datetime-local" required />
                            </div>
                            <div>
                                <label class="form-label" for="meeting-end-input">Ends</label>
                                <input id="meeting-end-input" class="form-input" type="datetime-local" required />
                            </div>
                        </div>
                        <label class="form-label" for="meeting-location-input">Location (optional)</label>
                        <input id="meeting-location-input" class="form-input" type="text" maxlength="${MEETING_LOCATION_MAX_LENGTH}" placeholder="Room or address" autocomplete="off" />
                        <label class="form-label" for="meeting-url-input">Video link (optional)</label>
                        <input id="meeting-url-input" class="form-input" type="url" maxlength="${MEETING_URL_MAX_LENGTH}" placeholder="https://…" autocomplete="off" />
                        <label class="form-label" for="meeting-notes-input">Notes (optional)</label>
                        <textarea id="meeting-notes-input" class="form-input form-textarea" rows="2" maxlength="${MEETING_NOTES_MAX_LENGTH}" placeholder="Agenda or details" autocomplete="off"></textarea>
                        <button type="submit" id="meeting-create-btn" class="submit-btn submit-btn--compact">Add meeting</button>
                    </form>
                    <p id="meeting-create-message" class="auth-message dash-role-message" aria-live="polite"></p>
                    <div id="meetings-list" class="meetings-list" aria-live="polite"></div>
                </section>
            `
        : '';

    const directMessagesSectionHtml = companyContext
        ? `
                <section class="dash-section">
                    <h3 class="dash-section-heading">Direct messages</h3>
                    <p class="dash-section-hint">Message one teammate at a time. Only you and that person can read the thread. Enable system notifications for ManageMe to see alerts when the app is open.</p>
                    <label class="form-label" for="dm-peer-select">Chat with</label>
                    <select id="dm-peer-select" class="form-input form-select" aria-label="Choose teammate to message">
                        <option value="">Choose teammate</option>
                    </select>
                    <div id="dm-thread" class="dm-thread" aria-live="polite"></div>
                    <form id="dm-send-form" class="dm-send-form">
                        <label class="form-label" for="dm-body-input">Message</label>
                        <textarea id="dm-body-input" class="form-input form-textarea dm-body-input" rows="3" maxlength="${MEMBER_MESSAGE_BODY_MAX_LENGTH}" placeholder="Write a message…" autocomplete="off"></textarea>
                        <button type="submit" id="dm-send-btn" class="submit-btn submit-btn--compact">Send</button>
                    </form>
                    <p id="dm-send-message" class="auth-message dash-role-message" aria-live="polite"></p>
                </section>
            `
        : '';

    const notebookSectionHtml = `
                <section class="dash-section dash-section--notebook">
                    <h3 class="dash-section-heading">My notebook</h3>
                    <p class="dash-section-hint">Private notes only you can see. Your company and teammates cannot open this.</p>
                    <label class="form-label" for="private-notebook-textarea">Notes</label>
                    <textarea id="private-notebook-textarea" class="form-input form-textarea notebook-textarea" rows="10" maxlength="${NOTEBOOK_MAX_LENGTH}" placeholder="Jot things down for yourself…" autocomplete="off"></textarea>
                    <p id="notebook-save-status" class="notebook-save-status" aria-live="polite"></p>
                </section>
            `;

    const holidayRequestSectionHtml = companyContext
        ? `
                <section class="dash-section">
                    <h3 class="dash-section-heading">Holiday requests</h3>
                    <p class="dash-section-hint">Request holiday days from your current balance. This appears once your owner sets your holiday allowance.</p>
                    <form id="holiday-request-form" class="news-post-form" hidden>
                        <label class="form-label" for="holiday-request-days">How many days?</label>
                        <input id="holiday-request-days" class="form-input" type="number" min="1" step="1" placeholder="e.g. 3" />
                        <button type="submit" id="holiday-request-btn" class="submit-btn submit-btn--compact">Request holiday</button>
                    </form>
                    <p id="holiday-balance-message" class="dash-section-hint"></p>
                    <p id="holiday-request-message" class="auth-message dash-role-message" aria-live="polite"></p>
                </section>
            `
        : '';

    const ownerHolidayRequestsHtml =
        companyContext && companyContext.isOwner
            ? `
                <section class="dash-section">
                    <h3 class="dash-section-heading">Holiday approvals</h3>
                    <p class="dash-section-hint">Incoming holiday requests appear here in real time. Approving deducts days from that person's holiday balance.</p>
                    <ul id="holiday-requests-list" class="audit-log-list" aria-label="Holiday requests"></ul>
                </section>
            `
            : '';

    const directoryAndOpsHtml = companyContext
        ? `
                <section class="dash-section">
                    <h3 class="dash-section-heading">Directory</h3>
                    <p class="dash-section-hint">Everyone in your company with role, status, and profile basics. Use search to filter by name, email, role, team, or status.</p>
                    <label class="sr-only" for="directory-search">Search directory</label>
                    <input type="search" id="directory-search" class="form-input directory-search" placeholder="Search people…" autocomplete="off" />
                    <div class="directory-table-wrap">
                        <table class="directory-table" aria-label="Company directory">
                            <thead>
                                <tr>
                                    <th scope="col">Name</th>
                                    <th scope="col">Email</th>
                                    <th scope="col">Role</th>
                                    <th scope="col">Status</th>
                                    <th scope="col">Holiday status</th>
                                    <th scope="col">Teams</th>
                                    <th scope="col"><span class="sr-only">Actions</span></th>
                                </tr>
                            </thead>
                            <tbody id="directory-tbody"></tbody>
                        </table>
                    </div>
                    <div class="directory-export-row">
                        <button type="button" id="directory-export-btn" class="submit-btn submit-btn--table">Export to CSV</button>
                    </div>
                </section>

                <section class="dash-section">
                    <h3 class="dash-section-heading">Teams &amp; departments</h3>
                    <p class="dash-section-hint">Organize people into teams. Assign membership when you edit someone in the directory.</p>
                    <ul id="team-list" class="team-list" aria-label="Teams and departments"></ul>
                    <div id="team-manage-controls" class="team-manage-controls"${
                        companyContext.canManageMembers ? '' : ' hidden'
                    }>
                        <div class="dash-add-role-row">
                            <input type="text" id="new-team-name-input" class="form-input dash-role-input" placeholder="Team or department name" maxlength="80" autocomplete="off" />
                            <button type="button" id="add-team-btn" class="submit-btn submit-btn--compact">Add team</button>
                        </div>
                        <p id="team-form-message" class="auth-message dash-role-message" aria-live="polite"></p>
                    </div>
                </section>
            `
        : '';

    const auditSectionHtml = companyContext
        ? `
                <section class="dash-section">
                    <h3 class="dash-section-heading">Audit log</h3>
                    <p class="dash-section-hint">Recent changes across invitations, members, teams, and roles (newest first).</p>
                    <ul id="audit-log-list" class="audit-log-list" aria-label="Audit log"></ul>
                </section>
            `
        : '';

    const rolesSectionHtml =
        companyContext && companyContext.isOwner
            ? `
                <section class="dash-section">
                <div class="dash-roles-card" id="dash-roles-section">
                    <h3 class="dash-roles-title">Roles for invitations</h3>
                    <p class="dash-roles-hint">Define how your company is structured for new hires. These roles appear when you invite someone. Check <strong>High up</strong> so people in that role can send invites (same as Manager and Admin).</p>
                    <ul id="dash-role-list" class="dash-role-list" aria-label="Current invitation roles"></ul>
                    <div class="dash-add-role-row">
                        <input type="text" id="new-role-input" class="form-input dash-role-input" placeholder="e.g. Designer, Billing admin" maxlength="80" autocomplete="off" />
                        <button type="button" id="add-role-btn" class="submit-btn submit-btn--compact">Add role</button>
                    </div>
                    <div class="dash-high-up-row">
                        <label class="dash-checkbox-label" for="role-high-up-checkbox">
                            <input type="checkbox" id="role-high-up-checkbox" />
                            <span>High up</span>
                        </label>
                        <span class="dash-high-up-hint">Can send invitations</span>
                    </div>
                    <p id="role-form-message" class="auth-message dash-role-message" aria-live="polite"></p>
                </div>
                </section>
            `
            : '';

    appRoot.innerHTML = `
    <div class="app-shell">
        <header class="dash-header">
            <div class="dash-brand">
                <span class="dash-logo">ManageMe</span>
                <span class="dash-greeting">Hi, ${escapeHtml(greetingName)}</span>
            </div>
            <div class="dash-actions">
                <button type="button" id="settings-btn" class="icon-btn" aria-expanded="false" aria-haspopup="true" aria-controls="settings-menu" title="Settings">
                    <span class="icon-btn-label">Settings</span>
                    <svg class="gear-icon" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                        <path
                            fill="currentColor"
                            d="M19.14 12.94c0.04-0.31 0.06-0.63 0.06-0.94 0-0.31-0.02-0.63-0.06-0.94l2.03-1.58c0.18-0.14 0.23-0.41 0.12-0.61l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39 0.96c-0.5-0.38-1.03-0.7-1.62-0.94l-0.36-2.54c-0.04-0.24-0.24-0.41-0.48-0.41h-3.84c-0.24 0-0.43 0.17-0.47 0.41l-0.36 2.54c-0.59 0.24-1.13 0.57-1.62 0.94l-2.39-0.96c-0.22-0.08-0.47 0-0.59 0.22L2.74 8.87c-0.12 0.21-0.08 0.47 0.12 0.61l2.03 1.58c-0.04 0.31-0.07 0.63-0.07 0.94s0.02 0.63 0.06 0.94l-2.03 1.58c-0.18 0.14-0.23 0.41-0.12 0.61l1.92 3.32c0.12 0.22 0.37 0.29 0.59 0.22l2.39-0.96c0.5 0.38 1.03 0.7 1.62 0.94l0.36 2.54c0.05 0.24 0.24 0.41 0.48 0.41h3.84c0.24 0 0.44-0.17 0.47-0.41l0.36-2.54c0.59-0.24 1.13-0.56 1.62-0.94l2.39 0.96c0.22 0.08 0.47 0 0.59-0.22l1.92-3.32c0.12-0.22 0.07-0.47-0.12-0.61l-2.01-1.58z M12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"
                        />
                    </svg>
                </button>
                <div id="settings-menu" class="settings-menu" role="menu" hidden>
                    <button type="button" id="make-invite-btn" class="settings-menu-item settings-menu-item--neutral${
                        companyContext && !companyContext.canSendInvites
                            ? ' settings-menu-item--disabled'
                            : ''
                    }" role="menuitem"${
                        companyContext && !companyContext.canSendInvites
                            ? ' disabled aria-disabled="true" title="Only Managers, Admins, and High up roles can send invitations."'
                            : ''
                    }>Make an invitation</button>
                    <button type="button" id="manage-invites-btn" class="settings-menu-item settings-menu-item--neutral${
                        companyContext && !companyContext.canSendInvites
                            ? ' settings-menu-item--disabled'
                            : ''
                    }" role="menuitem"${
                        companyContext && !companyContext.canSendInvites
                            ? ' disabled aria-disabled="true" title="Only Managers, Admins, and High up roles can manage invitations."'
                            : ''
                    }>Manage invitations</button>
                    ${
                        companyContext?.isOwner
                            ? '<button type="button" id="manage-holidays-btn" class="settings-menu-item settings-menu-item--neutral" role="menuitem">Manage holidays</button>'
                            : ''
                    }
                    ${
                        companyContext?.isOwner
                            ? '<button type="button" id="transfer-ownership-btn" class="settings-menu-item settings-menu-item--neutral" role="menuitem">Transfer ownership</button>'
                            : ''
                    }
                    <button type="button" id="theme-cycle-btn" class="settings-menu-item settings-menu-item--neutral" role="menuitem">Theme</button>
                    <button type="button" id="open-ai-assistant-btn" class="settings-menu-item settings-menu-item--neutral" role="menuitem">AI assistant</button>
                    <button type="button" id="sign-out-btn" class="settings-menu-item" role="menuitem">Sign out</button>
                </div>
            </div>
        </header>

        <main class="dash-main">
            <div class="dash-workspace">
                <section class="dash-section dash-section--intro">
                    <h2 class="dash-placeholder-title">Dashboard</h2>
                    ${membershipHtml}
                </section>
                ${companyNewsSectionHtml}
                ${meetingsSectionHtml}
                ${directMessagesSectionHtml}
                ${notebookSectionHtml}
                ${holidayRequestSectionHtml}
                ${directoryAndOpsHtml}
                ${rolesSectionHtml}
                ${ownerHolidayRequestsHtml}
                ${auditSectionHtml}
                <p class="dash-placeholder-text">Your company command center will grow here as ManageMe adds more management tools.</p>
            </div>
        </main>

        <div id="invite-modal" class="modal-backdrop" hidden>
            <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="invite-modal-title">
                <h2 id="invite-modal-title" class="modal-title">Create invitation</h2>
                <p class="modal-subtitle">Bring someone into your company workspace. We save the invite and give you an ID to share; it expires in <strong>${INVITE_EXPIRY_DAYS} days</strong>. Accepting it adds them to your company in ManageMe.</p>

                <form id="invite-create-form" class="auth-form modal-form">
                    <label class="form-label" for="invite-person-name">Who is this person?</label>
                    <input id="invite-person-name" class="form-input" type="text" autocomplete="name" placeholder="Full name" required maxlength="120" />

                    <label class="form-label" for="invite-role-select">Role in the company</label>
                    <select id="invite-role-select" class="form-input form-select" required>
                        <option value="">Choose a role</option>
                    </select>

                    <button type="submit" id="invite-generate-btn" class="submit-btn">Create invitation</button>
                </form>

                <div id="invite-result-block" class="invite-result-block" hidden>
                    <label class="form-label" for="invite-result-output">Invitation ID (share this)</label>
                    <div class="invite-result-row">
                        <input id="invite-result-output" class="form-input invite-result-input" type="text" readonly />
                        <button type="button" id="invite-copy-btn" class="submit-btn submit-btn--inline">Copy</button>
                    </div>
                    <p id="invite-expiry-note" class="invite-expiry-note" hidden></p>
                </div>

                <p id="invite-modal-message" class="auth-message" aria-live="polite"></p>

                <button type="button" id="invite-modal-close" class="modal-close-btn">Close</button>
            </div>
        </div>

        <div id="invite-manage-modal" class="modal-backdrop" hidden>
            <div class="modal-card modal-card--wide" role="dialog" aria-modal="true" aria-labelledby="invite-manage-title">
                <h2 id="invite-manage-title" class="modal-title">Manage invitations</h2>
                <p class="modal-subtitle">Review current invites, copy IDs, revoke pending invites, or extend expiry by ${INVITE_EXPIRY_DAYS} days.</p>
                <div id="invite-manage-list" class="meeting-list" aria-live="polite"></div>
                <p id="invite-manage-message" class="auth-message" aria-live="polite"></p>
                <button type="button" id="invite-manage-close" class="modal-close-btn">Close</button>
            </div>
        </div>

        <div id="member-edit-modal" class="modal-backdrop" hidden>
            <div class="modal-card modal-card--wide" role="dialog" aria-modal="true" aria-labelledby="member-edit-title">
                <h2 id="member-edit-title" class="modal-title">Edit member</h2>
                <p id="member-edit-subtitle" class="modal-subtitle"></p>

                <form id="member-edit-form" class="auth-form modal-form">
                    <label class="form-label" for="member-edit-role">Role</label>
                    <select id="member-edit-role" class="form-input form-select" required></select>

                    <label class="form-label" for="member-edit-status">Status</label>
                    <select id="member-edit-status" class="form-input form-select" required>
                        <option value="active">Active</option>
                        <option value="suspended">Suspended</option>
                        <option value="offboarded">Offboarded</option>
                    </select>

                    <fieldset class="member-edit-teams-field">
                        <legend class="form-label">Teams</legend>
                        <div id="member-edit-teams" class="member-edit-teams"></div>
                    </fieldset>

                    <button type="submit" id="member-edit-save-btn" class="submit-btn">Save changes</button>
                </form>

                <p id="member-edit-message" class="auth-message" aria-live="polite"></p>
                <button type="button" id="member-edit-cancel" class="modal-close-btn">Cancel</button>
            </div>
        </div>

        <div id="holiday-manage-modal" class="modal-backdrop" hidden>
            <div class="modal-card modal-card--wide" role="dialog" aria-modal="true" aria-labelledby="holiday-manage-title">
                <h2 id="holiday-manage-title" class="modal-title">Manage holidays</h2>
                <p class="modal-subtitle">Set each person's available holiday days. Save to update balances in Firestore.</p>
                <form id="holiday-manage-form" class="auth-form modal-form">
                    <div id="holiday-manage-grid" class="holiday-manage-grid"></div>
                    <button type="submit" id="holiday-manage-submit" class="submit-btn">Submit</button>
                </form>
                <p id="holiday-manage-message" class="auth-message" aria-live="polite"></p>
                <button type="button" id="holiday-manage-close" class="modal-close-btn">Close</button>
            </div>
        </div>

        <div id="transfer-ownership-modal" class="modal-backdrop" hidden>
            <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="transfer-ownership-title">
                <h2 id="transfer-ownership-title" class="modal-title">Transfer ownership</h2>
                <p class="modal-subtitle">Choose someone in your company to become the new owner. You will be downgraded to Admin.</p>
                <form id="transfer-ownership-form" class="auth-form modal-form">
                    <label class="form-label" for="transfer-ownership-select">New owner</label>
                    <select id="transfer-ownership-select" class="form-input form-select" required></select>
                    <button type="submit" id="transfer-ownership-submit" class="submit-btn">Transfer ownership</button>
                </form>
                <p id="transfer-ownership-message" class="auth-message" aria-live="polite"></p>
                <button type="button" id="transfer-ownership-close" class="modal-close-btn">Cancel</button>
            </div>
        </div>

        <div id="meeting-edit-modal" class="modal-backdrop" hidden>
            <div class="modal-card modal-card--wide" role="dialog" aria-modal="true" aria-labelledby="meeting-edit-title">
                <h2 id="meeting-edit-title" class="modal-title">Edit meeting</h2>
                <p class="modal-subtitle">Update the time, place, or notes. Only the organizer can change this meeting.</p>
                <form id="meeting-edit-form" class="auth-form modal-form">
                    <label class="form-label" for="meeting-edit-title-input">Title</label>
                    <input id="meeting-edit-title-input" class="form-input" type="text" maxlength="${MEETING_TITLE_MAX_LENGTH}" required autocomplete="off" />
                    <div class="meeting-datetime-row">
                        <div>
                            <label class="form-label" for="meeting-edit-start-input">Starts</label>
                            <input id="meeting-edit-start-input" class="form-input" type="datetime-local" required />
                        </div>
                        <div>
                            <label class="form-label" for="meeting-edit-end-input">Ends</label>
                            <input id="meeting-edit-end-input" class="form-input" type="datetime-local" required />
                        </div>
                    </div>
                    <label class="form-label" for="meeting-edit-location-input">Location (optional)</label>
                    <input id="meeting-edit-location-input" class="form-input" type="text" maxlength="${MEETING_LOCATION_MAX_LENGTH}" autocomplete="off" />
                    <label class="form-label" for="meeting-edit-url-input">Video link (optional)</label>
                    <input id="meeting-edit-url-input" class="form-input" type="url" maxlength="${MEETING_URL_MAX_LENGTH}" autocomplete="off" />
                    <label class="form-label" for="meeting-edit-notes-input">Notes (optional)</label>
                    <textarea id="meeting-edit-notes-input" class="form-input form-textarea" rows="2" maxlength="${MEETING_NOTES_MAX_LENGTH}" autocomplete="off"></textarea>
                    <button type="submit" id="meeting-edit-save-btn" class="submit-btn">Save changes</button>
                </form>
                <p id="meeting-edit-message" class="auth-message" aria-live="polite"></p>
                <button type="button" id="meeting-edit-cancel-btn" class="modal-close-btn">Cancel</button>
            </div>
        </div>

        <div id="ai-chat-modal" class="modal-backdrop" hidden>
            <div class="modal-card modal-card--wide ai-chat-card" role="dialog" aria-modal="true" aria-labelledby="ai-chat-title">
                <h2 id="ai-chat-title" class="modal-title">AI assistant</h2>
                <p class="modal-subtitle">Ask about your company or let the assistant run actions you allow (news, meetings, messages, holidays, invites). Chat is saved to your account.</p>
                <div id="ai-chat-messages" class="ai-chat-messages" aria-live="polite"></div>
                <form id="ai-chat-form" class="ai-chat-form">
                    <label class="sr-only" for="ai-chat-input">Message</label>
                    <textarea id="ai-chat-input" class="form-input form-textarea ai-chat-input" rows="2" maxlength="8000" placeholder="Message the assistant…" autocomplete="off"></textarea>
                    <div class="ai-chat-actions">
                        <button type="submit" id="ai-chat-send-btn" class="submit-btn submit-btn--compact">Send</button>
                        <button type="button" id="ai-chat-clear-btn" class="modal-close-btn ai-chat-clear-btn">Clear history</button>
                    </div>
                </form>
                <p id="ai-chat-status" class="auth-message ai-chat-status" aria-live="polite"></p>
                <button type="button" id="ai-chat-close-btn" class="modal-close-btn">Close</button>
            </div>
        </div>
    </div>
`;

    syncThemePreferenceUi();

    const settingsBtn = document.getElementById(
        'settings-btn'
    ) as HTMLButtonElement;
    const settingsMenu = document.getElementById(
        'settings-menu'
    ) as HTMLDivElement;
    const signOutBtn = document.getElementById(
        'sign-out-btn'
    ) as HTMLButtonElement;
    const makeInviteBtn = document.getElementById(
        'make-invite-btn'
    ) as HTMLButtonElement;
    const manageInvitesBtn = document.getElementById(
        'manage-invites-btn'
    ) as HTMLButtonElement;
    const manageHolidaysBtn = document.getElementById(
        'manage-holidays-btn'
    ) as HTMLButtonElement | null;
    const transferOwnershipBtn = document.getElementById(
        'transfer-ownership-btn'
    ) as HTMLButtonElement | null;
    const inviteModal = document.getElementById(
        'invite-modal'
    ) as HTMLDivElement;
    const inviteModalClose = document.getElementById(
        'invite-modal-close'
    ) as HTMLButtonElement;
    const inviteCreateForm = document.getElementById(
        'invite-create-form'
    ) as HTMLFormElement;
    const invitePersonName = document.getElementById(
        'invite-person-name'
    ) as HTMLInputElement;
    const inviteRoleSelect = document.getElementById(
        'invite-role-select'
    ) as HTMLSelectElement;
    const inviteGenerateBtn = document.getElementById(
        'invite-generate-btn'
    ) as HTMLButtonElement;
    const inviteResultBlock = document.getElementById(
        'invite-result-block'
    ) as HTMLDivElement;
    const inviteResultOutput = document.getElementById(
        'invite-result-output'
    ) as HTMLInputElement;
    const inviteCopyBtn = document.getElementById(
        'invite-copy-btn'
    ) as HTMLButtonElement;
    const inviteExpiryNote = document.getElementById(
        'invite-expiry-note'
    ) as HTMLParagraphElement;
    const inviteModalMessage = document.getElementById(
        'invite-modal-message'
    ) as HTMLParagraphElement;
    const inviteManageModal = document.getElementById(
        'invite-manage-modal'
    ) as HTMLDivElement | null;
    const inviteManageList = document.getElementById(
        'invite-manage-list'
    ) as HTMLDivElement | null;
    const inviteManageMessage = document.getElementById(
        'invite-manage-message'
    ) as HTMLParagraphElement | null;
    const inviteManageClose = document.getElementById(
        'invite-manage-close'
    ) as HTMLButtonElement | null;
    const newRoleInput = document.getElementById(
        'new-role-input'
    ) as HTMLInputElement | null;
    const addRoleBtn = document.getElementById(
        'add-role-btn'
    ) as HTMLButtonElement | null;
    const roleFormMessage = document.getElementById(
        'role-form-message'
    ) as HTMLParagraphElement | null;
    const roleHighUpCheckbox = document.getElementById(
        'role-high-up-checkbox'
    ) as HTMLInputElement | null;

    let latestInviteRoleEntries: InviteRoleEntry[] = companyContext
        ? companyContext.inviteRoles.slice()
        : [];

    const refreshDashRoleList = (entries: InviteRoleEntry[]): void => {
        const dashRoleList = document.getElementById('dash-role-list');
        if (!dashRoleList) {
            return;
        }
        dashRoleList.innerHTML = entries
            .map((entry) => {
                const label = escapeHtml(formatRoleForDisplay(entry.name));
                const badge = entry.highUp
                    ? ' <span class="dash-role-badge">High up</span>'
                    : '';
                return `<li class="dash-role-list-item">${label}${badge}</li>`;
            })
            .join('');
    };

    if (companyContext && companyContext.isOwner) {
        refreshDashRoleList(latestInviteRoleEntries);
        fillInviteRoleSelect(inviteRoleSelect, latestInviteRoleEntries);
    } else {
        fillInviteRoleSelect(
            inviteRoleSelect,
            companyContext?.inviteRoles ?? defaultInviteRoleEntries()
        );
    }

    let latestEmployees: CompanyEmployee[] = companyContext
        ? companyContext.employees.slice()
        : [];
    let latestTeams: CompanyTeam[] = companyContext
        ? companyContext.teams.slice()
        : [];
    let latestInviteDocs: QueryDocumentSnapshot[] = [];
    let inviteManageActionBusy = false;

    const aiChatRef = doc(db, USER_AI_CHATS_COLLECTION, user.uid);
    let aiThreadMessages: AiChatStoredMessage[] = [];
    let aiLastResponseId: string | null = null;

    const persistAiChatState = async (): Promise<void> => {
        await setDoc(
            aiChatRef,
            {
                messages: capAiMessages(aiThreadMessages),
                lastResponseId: aiLastResponseId,
                updatedAt: serverTimestamp(),
            },
            { merge: true }
        );
    };

    const renderAiChatThread = (): void => {
        const wrap = document.getElementById(
            'ai-chat-messages'
        ) as HTMLDivElement | null;
        if (!wrap) {
            return;
        }
        if (aiThreadMessages.length === 0) {
            wrap.innerHTML =
                '<p class="ai-chat-empty">No messages yet. Ask a question or request an action.</p>';
            return;
        }
        wrap.innerHTML = aiThreadMessages
            .map((m) => {
                const roleClass =
                    m.role === 'user'
                        ? 'ai-chat-bubble--user'
                        : 'ai-chat-bubble--assistant';
                const label = m.role === 'user' ? 'You' : 'Assistant';
                const isAssistant = m.role === 'assistant';
                const bodyHtml = isAssistant
                    ? assistantMarkdownToSafeHtml(m.content)
                    : escapeHtml(m.content);
                const textClass = isAssistant
                    ? 'ai-chat-bubble-text ai-chat-bubble-text--md'
                    : 'ai-chat-bubble-text';
                return `<div class="ai-chat-bubble ${roleClass}"><span class="ai-chat-bubble-label">${label}</span><div class="${textClass}">${bodyHtml}</div></div>`;
            })
            .join('');
        wrap.scrollTop = wrap.scrollHeight;
    };

    const findPeerUidForAi = (
        identifier: string
    ): { uid: string | null; error?: string } => {
        const t = identifier.trim().toLowerCase();
        if (!t) {
            return { uid: null, error: 'peer_identifier is empty' };
        }
        const byEmail = latestEmployees.find(
            (e) => (e.email ?? '').toLowerCase() === t
        );
        if (byEmail) {
            if ((byEmail.status ?? 'active') === 'offboarded') {
                return { uid: null, error: 'That person is offboarded.' };
            }
            return { uid: byEmail.uid };
        }
        const matches = latestEmployees.filter((e) => {
            if ((e.status ?? 'active') === 'offboarded') {
                return false;
            }
            const name = memberDisplayName(e).toLowerCase();
            return (
                name.includes(t) ||
                t.split(/\s+/).every((w) => w.length > 0 && name.includes(w))
            );
        });
        if (matches.length === 1) {
            return { uid: matches[0].uid };
        }
        if (matches.length === 0) {
            return {
                uid: null,
                error: 'No teammate matched that name or email.',
            };
        }
        const names = matches.map((m) => memberDisplayName(m)).join(', ');
        return {
            uid: null,
            error: `Multiple people matched. Be more specific: ${names}`,
        };
    };

    const executeDashboardAiTool = async (
        name: string,
        argsJson: string
    ): Promise<string> => {
        let args: Record<string, unknown>;
        try {
            args = JSON.parse(argsJson) as Record<string, unknown>;
        } catch {
            return JSON.stringify({ ok: false, error: 'Invalid JSON arguments' });
        }
        const actorLabel =
            user.displayName?.trim() || user.email?.split('@')[0] || 'Member';

        if (name === 'get_company_snapshot') {
            if (!companyContext) {
                return JSON.stringify({
                    ok: true,
                    companyName: null,
                    note: 'You are not in a company workspace yet.',
                });
            }
            return JSON.stringify({
                ok: true,
                companyName: companyContext.companyName,
                yourRole: companyContext.role,
                memberCount: latestEmployees.length,
                teamCount: latestTeams.length,
                canSendInvites: companyContext.canSendInvites,
            });
        }

        if (name === 'get_directory') {
            if (!companyContext) {
                return JSON.stringify({ ok: false, error: 'No company' });
            }
            const filterRaw =
                typeof args.filter === 'string'
                    ? args.filter.trim().toLowerCase()
                    : '';
            let rows = latestEmployees.map((e) => ({
                name: memberDisplayName(e),
                email: e.email ?? '',
                role: formatRoleForDisplay(e.role),
                status: statusDisplayLabel(e.status ?? 'active'),
            }));
            if (filterRaw) {
                rows = rows.filter(
                    (r) =>
                        r.name.toLowerCase().includes(filterRaw) ||
                        r.email.toLowerCase().includes(filterRaw) ||
                        r.role.toLowerCase().includes(filterRaw) ||
                        r.status.toLowerCase().includes(filterRaw)
                );
            }
            return JSON.stringify({ ok: true, people: rows });
        }

        if (name === 'list_meetings') {
            if (!companyContext) {
                return JSON.stringify({ ok: false, error: 'No company' });
            }
            try {
                const mq = query(
                    collection(
                        db,
                        'companies',
                        companyContext.companyId,
                        MEETINGS_SUBCOLLECTION
                    ),
                    orderBy('startAt', 'asc'),
                    limit(MEETINGS_QUERY_LIMIT)
                );
                const snap = await getDocs(mq);
                const list = snap.docs.map((d) => {
                    const x = d.data();
                    return {
                        id: d.id,
                        title: typeof x.title === 'string' ? x.title : '',
                        range: meetingRangeLabel(x.startAt, x.endAt),
                        organizer:
                            typeof x.organizerLabel === 'string'
                                ? x.organizerLabel
                                : '',
                        location:
                            typeof x.location === 'string' ? x.location : '',
                        url:
                            typeof x.meetingUrl === 'string' ? x.meetingUrl : '',
                    };
                });
                return JSON.stringify({ ok: true, meetings: list });
            } catch (err) {
                return JSON.stringify({
                    ok: false,
                    error: friendlyFirestoreError(err, 'Could not list meetings.'),
                });
            }
        }

        if (name === 'list_invitation_roles') {
            if (!companyContext) {
                return JSON.stringify({
                    ok: false,
                    error: 'No company workspace.',
                });
            }
            const roles = latestInviteRoleEntries.map((e) => ({
                name: e.name,
                display_name: formatRoleForDisplay(e.name),
                high_up: e.highUp,
            }));
            return JSON.stringify({
                ok: true,
                roles,
                note: 'Use each role\'s `name` (lowercase keys like member) as the role argument to create_invitation.',
            });
        }

        if (!companyContext) {
            return JSON.stringify({
                ok: false,
                error: 'Join or create a company before using this action.',
            });
        }

        if (name === 'post_company_news') {
            const body =
                typeof args.body === 'string' ? args.body.trim() : '';
            if (!body) {
                return JSON.stringify({ ok: false, error: 'body is required' });
            }
            if (body.length > NEWS_BODY_MAX_LENGTH) {
                return JSON.stringify({ ok: false, error: 'News text too long' });
            }
            try {
                await addDoc(
                    collection(
                        db,
                        'companies',
                        companyContext.companyId,
                        COMPANY_NEWS_SUBCOLLECTION
                    ),
                    {
                        authorUid: user.uid,
                        authorLabel: actorLabel,
                        body,
                        createdAt: serverTimestamp(),
                    }
                );
                try {
                    await appendAuditEvent(companyContext.companyId, {
                        actorUid: user.uid,
                        actorLabel,
                        action: 'news_posted',
                        summary: `${actorLabel} posted company news (AI)`,
                        detail:
                            body.length > 180
                                ? `${body.slice(0, 180).trim()}…`
                                : body,
                    });
                } catch {
                    /* best-effort */
                }
                return JSON.stringify({
                    ok: true,
                    message: 'Posted to company news.',
                });
            } catch (err) {
                return JSON.stringify({
                    ok: false,
                    error: friendlyFirestoreError(err, 'Could not post news.'),
                });
            }
        }

        if (name === 'schedule_meeting') {
            const title =
                typeof args.title === 'string' ? args.title.trim() : '';
            const startIso =
                typeof args.start_iso === 'string' ? args.start_iso.trim() : '';
            const endIso =
                typeof args.end_iso === 'string' ? args.end_iso.trim() : '';
            if (!title || !startIso || !endIso) {
                return JSON.stringify({
                    ok: false,
                    error: 'title, start_iso, and end_iso are required',
                });
            }
            const startD = new Date(startIso);
            const endD = new Date(endIso);
            if (Number.isNaN(startD.getTime()) || Number.isNaN(endD.getTime())) {
                return JSON.stringify({ ok: false, error: 'Invalid dates' });
            }
            if (endD.getTime() <= startD.getTime()) {
                return JSON.stringify({
                    ok: false,
                    error: 'End must be after start',
                });
            }
            const loc =
                typeof args.location === 'string' ? args.location.trim() : '';
            const urlRaw =
                typeof args.meeting_url === 'string'
                    ? args.meeting_url.trim()
                    : '';
            const notes =
                typeof args.notes === 'string' ? args.notes.trim() : '';
            if (loc.length > MEETING_LOCATION_MAX_LENGTH) {
                return JSON.stringify({ ok: false, error: 'Location too long' });
            }
            if (urlRaw.length > MEETING_URL_MAX_LENGTH) {
                return JSON.stringify({ ok: false, error: 'URL too long' });
            }
            if (notes.length > MEETING_NOTES_MAX_LENGTH) {
                return JSON.stringify({ ok: false, error: 'Notes too long' });
            }
            try {
                await addDoc(
                    collection(
                        db,
                        'companies',
                        companyContext.companyId,
                        MEETINGS_SUBCOLLECTION
                    ),
                    {
                        organizerUid: user.uid,
                        organizerLabel: actorLabel,
                        title,
                        startAt: Timestamp.fromDate(startD),
                        endAt: Timestamp.fromDate(endD),
                        location: loc || null,
                        meetingUrl: urlRaw || null,
                        notes: notes || null,
                        createdAt: serverTimestamp(),
                    }
                );
                try {
                    await appendAuditEvent(companyContext.companyId, {
                        actorUid: user.uid,
                        actorLabel,
                        action: 'meeting_created',
                        summary: `${actorLabel} scheduled a meeting (AI)`,
                        detail: title,
                    });
                } catch {
                    /* best-effort */
                }
                return JSON.stringify({ ok: true, message: 'Meeting scheduled.' });
            } catch (err) {
                return JSON.stringify({
                    ok: false,
                    error: friendlyFirestoreError(
                        err,
                        'Could not create meeting.'
                    ),
                });
            }
        }

        if (name === 'send_direct_message') {
            const peerId =
                typeof args.peer_identifier === 'string'
                    ? args.peer_identifier
                    : '';
            const message =
                typeof args.message === 'string' ? args.message.trim() : '';
            if (!peerId || !message) {
                return JSON.stringify({
                    ok: false,
                    error: 'peer_identifier and message are required',
                });
            }
            if (message.length > MEMBER_MESSAGE_BODY_MAX_LENGTH) {
                return JSON.stringify({ ok: false, error: 'Message too long' });
            }
            const resolved = findPeerUidForAi(peerId);
            if (!resolved.uid) {
                return JSON.stringify({
                    ok: false,
                    error: resolved.error ?? 'Could not resolve teammate',
                });
            }
            const peerEmp = latestEmployees.find(
                (e) => e.uid === resolved.uid
            );
            if (!peerEmp) {
                return JSON.stringify({ ok: false, error: 'Peer not found' });
            }
            const toLabel = memberDisplayName(peerEmp);
            try {
                await addDoc(
                    collection(
                        db,
                        'companies',
                        companyContext.companyId,
                        MEMBER_MESSAGES_SUBCOLLECTION
                    ),
                    {
                        fromUid: user.uid,
                        fromLabel: actorLabel,
                        toUid: resolved.uid,
                        toLabel,
                        body: message,
                        createdAt: serverTimestamp(),
                    }
                );
                return JSON.stringify({
                    ok: true,
                    message: `Direct message sent to ${toLabel}.`,
                });
            } catch (err) {
                return JSON.stringify({
                    ok: false,
                    error: friendlyFirestoreError(err, 'Could not send message.'),
                });
            }
        }

        if (name === 'request_holiday_days') {
            const daysRaw = args.days;
            const days =
                typeof daysRaw === 'number' && Number.isFinite(daysRaw)
                    ? Math.floor(daysRaw)
                    : 0;
            if (days <= 0) {
                return JSON.stringify({
                    ok: false,
                    error: 'days must be positive',
                });
            }
            const me = latestEmployees.find((emp) => emp.uid === user.uid);
            if (
                !me ||
                typeof me.holidayDays !== 'number' ||
                !Number.isFinite(me.holidayDays)
            ) {
                return JSON.stringify({
                    ok: false,
                    error: 'Holiday allowance is not set for you.',
                });
            }
            if (days > me.holidayDays) {
                return JSON.stringify({
                    ok: false,
                    error: 'Request exceeds remaining holiday balance.',
                });
            }
            try {
                await addDoc(
                    collection(
                        db,
                        'companies',
                        companyContext.companyId,
                        HOLIDAY_REQUESTS_SUBCOLLECTION
                    ),
                    {
                        requesterUid: user.uid,
                        requesterLabel: actorLabel,
                        days,
                        status: 'pending',
                        createdAt: serverTimestamp(),
                    }
                );
                try {
                    await appendAuditEvent(companyContext.companyId, {
                        actorUid: user.uid,
                        actorLabel,
                        action: 'holiday_requested',
                        summary: `${actorLabel} requested ${days} holiday day(s) (AI)`,
                    });
                } catch {
                    /* best-effort */
                }
                return JSON.stringify({
                    ok: true,
                    message: 'Holiday request submitted.',
                });
            } catch (err) {
                return JSON.stringify({
                    ok: false,
                    error: friendlyFirestoreError(
                        err,
                        'Could not submit holiday request.'
                    ),
                });
            }
        }

        if (name === 'create_invitation') {
            if (!companyContext.canSendInvites) {
                return JSON.stringify({
                    ok: false,
                    error: 'Your role cannot create invitations.',
                });
            }
            const inviteeName =
                typeof args.invitee_name === 'string'
                    ? args.invitee_name.trim()
                    : '';
            const roleRaw =
                typeof args.role === 'string' ? args.role.trim() : '';
            if (!inviteeName || !roleRaw) {
                return JSON.stringify({
                    ok: false,
                    error: 'invitee_name and role are required',
                });
            }
            const allowed = latestInviteRoleEntries.map((e) =>
                e.name.trim().toLowerCase()
            );
            if (!allowed.includes(roleRaw.toLowerCase())) {
                return JSON.stringify({
                    ok: false,
                    error: `Role must be one of: ${latestInviteRoleEntries.map((e) => e.name).join(', ')}`,
                });
            }
            const roleKey =
                latestInviteRoleEntries.find(
                    (e) => e.name.trim().toLowerCase() === roleRaw.toLowerCase()
                )?.name ?? roleRaw;
            try {
                const expiryMs =
                    Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
                const expiresAt = Timestamp.fromMillis(expiryMs);
                const docRef = await addDoc(collection(db, INVITES_COLLECTION), {
                    companyId: companyContext.companyId,
                    role: roleKey,
                    inviteeName,
                    createdByUid: user.uid,
                    createdAt: serverTimestamp(),
                    expiresAt,
                    used: false,
                });
                try {
                    await appendAuditEvent(companyContext.companyId, {
                        actorUid: user.uid,
                        actorLabel,
                        action: 'invite_created',
                        summary: `Invitation created for ${inviteeName} (AI)`,
                        detail: `Role: ${formatRoleForDisplay(roleKey)}`,
                    });
                } catch {
                    /* best-effort */
                }
                return JSON.stringify({
                    ok: true,
                    invitationId: docRef.id,
                    message:
                        'Invitation created. Share the invitation ID with your teammate.',
                });
            } catch (err) {
                return JSON.stringify({
                    ok: false,
                    error: friendlyFirestoreError(
                        err,
                        'Could not create invitation.'
                    ),
                });
            }
        }

        return JSON.stringify({ ok: false, error: `Unknown tool: ${name}` });
    };

    const runAiAssistantTurn = async (userText: string): Promise<string> => {
        const idToken = await user.getIdToken();
        let responseId = aiLastResponseId ?? undefined;
        const nextInput: Record<string, unknown>[] = [
            {
                type: 'message',
                role: 'user',
                content: userText,
            },
        ];
        let assistantText = '';

        for (let step = 0; step < AI_TOOL_LOOP_MAX; step++) {
            const body: Record<string, unknown> = {
                model: DEFAULT_AI_MODEL,
                instructions: MANAGE_ME_AI_INSTRUCTIONS,
                input: nextInput,
                tools: MANAGE_ME_AI_TOOLS,
            };
            if (responseId) {
                body.previous_response_id = responseId;
            }

            const result = await postManageMeChatApi(idToken, body);
            if (result.ok === false) {
                throw new Error(
                    result.status
                        ? `Chat API ${result.status}: ${result.message}`
                        : result.message
                );
            }

            const parsed = parseOpenAiChatResponse(result.data);
            if (parsed.id) {
                responseId = parsed.id;
                aiLastResponseId = parsed.id;
            }

            if (parsed.functionCalls.length > 0) {
                nextInput.length = 0;
                for (const fc of parsed.functionCalls) {
                    const output = await executeDashboardAiTool(
                        fc.name,
                        fc.arguments
                    );
                    nextInput.push({
                        type: 'function_call_output',
                        call_id: fc.call_id,
                        output,
                    });
                }
                continue;
            }

            assistantText =
                parsed.outputText?.trim() ||
                'Done. (The model returned no text.)';
            break;
        }

        if (!assistantText) {
            assistantText =
                'Stopped after too many tool steps. Try a simpler request.';
        }
        return assistantText;
    };

    const directorySearch = document.getElementById(
        'directory-search'
    ) as HTMLInputElement | null;
    const directoryTbody = document.getElementById(
        'directory-tbody'
    ) as HTMLTableSectionElement | null;
    const directoryExportBtn = document.getElementById(
        'directory-export-btn'
    ) as HTMLButtonElement | null;
    const teamListEl = document.getElementById(
        'team-list'
    ) as HTMLUListElement | null;
    const newTeamNameInput = document.getElementById(
        'new-team-name-input'
    ) as HTMLInputElement | null;
    const addTeamBtn = document.getElementById(
        'add-team-btn'
    ) as HTMLButtonElement | null;
    const teamFormMessage = document.getElementById(
        'team-form-message'
    ) as HTMLParagraphElement | null;
    const auditLogListEl = document.getElementById(
        'audit-log-list'
    ) as HTMLUListElement | null;
    const companyNewsListEl = document.getElementById(
        'company-news-list'
    ) as HTMLDivElement | null;
    const newsPostForm = document.getElementById(
        'news-post-form'
    ) as HTMLFormElement | null;
    const newsBodyInput = document.getElementById(
        'news-body-input'
    ) as HTMLTextAreaElement | null;
    const newsPostBtn = document.getElementById(
        'news-post-btn'
    ) as HTMLButtonElement | null;
    const newsPostMessage = document.getElementById(
        'news-post-message'
    ) as HTMLParagraphElement | null;
    const notebookTextarea = document.getElementById(
        'private-notebook-textarea'
    ) as HTMLTextAreaElement | null;
    const notebookSaveStatus = document.getElementById(
        'notebook-save-status'
    ) as HTMLParagraphElement | null;
    const memberEditModalEl = document.getElementById(
        'member-edit-modal'
    ) as HTMLDivElement | null;
    const memberEditFormEl = document.getElementById(
        'member-edit-form'
    ) as HTMLFormElement | null;
    const memberEditSubtitleEl = document.getElementById(
        'member-edit-subtitle'
    ) as HTMLParagraphElement | null;
    const memberEditRoleSelect = document.getElementById(
        'member-edit-role'
    ) as HTMLSelectElement | null;
    const memberEditStatusSelect = document.getElementById(
        'member-edit-status'
    ) as HTMLSelectElement | null;
    const memberEditTeamsEl = document.getElementById(
        'member-edit-teams'
    ) as HTMLDivElement | null;
    const memberEditMessageEl = document.getElementById(
        'member-edit-message'
    ) as HTMLParagraphElement | null;
    const memberEditCancelBtn = document.getElementById(
        'member-edit-cancel'
    ) as HTMLButtonElement | null;
    const memberEditSaveBtn = document.getElementById(
        'member-edit-save-btn'
    ) as HTMLButtonElement | null;
    const holidayManageModal = document.getElementById(
        'holiday-manage-modal'
    ) as HTMLDivElement | null;
    const holidayManageForm = document.getElementById(
        'holiday-manage-form'
    ) as HTMLFormElement | null;
    const holidayManageGrid = document.getElementById(
        'holiday-manage-grid'
    ) as HTMLDivElement | null;
    const holidayManageSubmitBtn = document.getElementById(
        'holiday-manage-submit'
    ) as HTMLButtonElement | null;
    const holidayManageMessage = document.getElementById(
        'holiday-manage-message'
    ) as HTMLParagraphElement | null;
    const holidayManageCloseBtn = document.getElementById(
        'holiday-manage-close'
    ) as HTMLButtonElement | null;
    const holidayRequestForm = document.getElementById(
        'holiday-request-form'
    ) as HTMLFormElement | null;
    const holidayRequestDaysInput = document.getElementById(
        'holiday-request-days'
    ) as HTMLInputElement | null;
    const holidayRequestBtn = document.getElementById(
        'holiday-request-btn'
    ) as HTMLButtonElement | null;
    const holidayRequestMessage = document.getElementById(
        'holiday-request-message'
    ) as HTMLParagraphElement | null;
    const holidayBalanceMessage = document.getElementById(
        'holiday-balance-message'
    ) as HTMLParagraphElement | null;
    const holidayRequestsListEl = document.getElementById(
        'holiday-requests-list'
    ) as HTMLUListElement | null;
    const transferOwnershipModal = document.getElementById(
        'transfer-ownership-modal'
    ) as HTMLDivElement | null;
    const transferOwnershipForm = document.getElementById(
        'transfer-ownership-form'
    ) as HTMLFormElement | null;
    const transferOwnershipSelect = document.getElementById(
        'transfer-ownership-select'
    ) as HTMLSelectElement | null;
    const transferOwnershipSubmit = document.getElementById(
        'transfer-ownership-submit'
    ) as HTMLButtonElement | null;
    const transferOwnershipMessage = document.getElementById(
        'transfer-ownership-message'
    ) as HTMLParagraphElement | null;
    const transferOwnershipClose = document.getElementById(
        'transfer-ownership-close'
    ) as HTMLButtonElement | null;
    const meetingCreateForm = document.getElementById(
        'meeting-create-form'
    ) as HTMLFormElement | null;
    const meetingTitleInput = document.getElementById(
        'meeting-title-input'
    ) as HTMLInputElement | null;
    const meetingStartInput = document.getElementById(
        'meeting-start-input'
    ) as HTMLInputElement | null;
    const meetingEndInput = document.getElementById(
        'meeting-end-input'
    ) as HTMLInputElement | null;
    const meetingLocationInput = document.getElementById(
        'meeting-location-input'
    ) as HTMLInputElement | null;
    const meetingUrlInput = document.getElementById(
        'meeting-url-input'
    ) as HTMLInputElement | null;
    const meetingNotesInput = document.getElementById(
        'meeting-notes-input'
    ) as HTMLTextAreaElement | null;
    const meetingCreateBtn = document.getElementById(
        'meeting-create-btn'
    ) as HTMLButtonElement | null;
    const meetingCreateMessage = document.getElementById(
        'meeting-create-message'
    ) as HTMLParagraphElement | null;
    const meetingsListEl = document.getElementById(
        'meetings-list'
    ) as HTMLDivElement | null;
    const meetingEditModalEl = document.getElementById(
        'meeting-edit-modal'
    ) as HTMLDivElement | null;
    const meetingEditFormEl = document.getElementById(
        'meeting-edit-form'
    ) as HTMLFormElement | null;
    const meetingEditTitleInput = document.getElementById(
        'meeting-edit-title-input'
    ) as HTMLInputElement | null;
    const meetingEditStartInput = document.getElementById(
        'meeting-edit-start-input'
    ) as HTMLInputElement | null;
    const meetingEditEndInput = document.getElementById(
        'meeting-edit-end-input'
    ) as HTMLInputElement | null;
    const meetingEditLocationInput = document.getElementById(
        'meeting-edit-location-input'
    ) as HTMLInputElement | null;
    const meetingEditUrlInput = document.getElementById(
        'meeting-edit-url-input'
    ) as HTMLInputElement | null;
    const meetingEditNotesInput = document.getElementById(
        'meeting-edit-notes-input'
    ) as HTMLTextAreaElement | null;
    const meetingEditSaveBtn = document.getElementById(
        'meeting-edit-save-btn'
    ) as HTMLButtonElement | null;
    const meetingEditCancelBtn = document.getElementById(
        'meeting-edit-cancel-btn'
    ) as HTMLButtonElement | null;
    const meetingEditMessageEl = document.getElementById(
        'meeting-edit-message'
    ) as HTMLParagraphElement | null;
    const dmPeerSelect = document.getElementById(
        'dm-peer-select'
    ) as HTMLSelectElement | null;
    const dmThreadEl = document.getElementById('dm-thread') as HTMLDivElement | null;
    const dmSendForm = document.getElementById(
        'dm-send-form'
    ) as HTMLFormElement | null;
    const dmBodyInput = document.getElementById(
        'dm-body-input'
    ) as HTMLTextAreaElement | null;
    const dmSendBtn = document.getElementById(
        'dm-send-btn'
    ) as HTMLButtonElement | null;
    const dmSendMessage = document.getElementById(
        'dm-send-message'
    ) as HTMLParagraphElement | null;

    let editingMemberUid: string | null = null;
    let editingMeetingId: string | null = null;
    let dmThreadUnsubscribe: Unsubscribe | null = null;
    let dmSubscribedPeerUid: string | null = null;

    const refreshAuditLogFromDocs = (docs: QueryDocumentSnapshot[]): void => {
        if (!auditLogListEl) {
            return;
        }
        if (docs.length === 0) {
            auditLogListEl.innerHTML =
                '<li class="audit-log-empty">No events yet.</li>';
            return;
        }
        auditLogListEl.innerHTML = docs
            .map((d) => {
                const x = d.data();
                const when = auditTimestampLabel(x.createdAt);
                const summary = typeof x.summary === 'string' ? x.summary : '';
                const actor =
                    typeof x.actorLabel === 'string' ? x.actorLabel : 'Someone';
                const detailRaw =
                    typeof x.detail === 'string' ? x.detail.trim() : '';
                const detail = detailRaw
                    ? `<div class="audit-log-detail">${escapeHtml(detailRaw)}</div>`
                    : '';
                return `<li class="audit-log-item"><div class="audit-log-meta"><span class="audit-log-time">${escapeHtml(when)}</span><span class="audit-log-actor">${escapeHtml(actor)}</span></div><div class="audit-log-summary">${escapeHtml(summary)}</div>${detail}</li>`;
            })
            .join('');
    };

    const refreshCompanyNewsFromDocs = (
        docs: QueryDocumentSnapshot[]
    ): void => {
        if (!companyNewsListEl) {
            return;
        }
        if (docs.length === 0) {
            companyNewsListEl.innerHTML =
                '<p class="news-list-empty">No posts yet. Share the first update above.</p>';
            return;
        }
        companyNewsListEl.innerHTML = docs
            .map((d) => {
                const x = d.data();
                const when = auditTimestampLabel(x.createdAt);
                const body = typeof x.body === 'string' ? x.body : '';
                const author =
                    typeof x.authorLabel === 'string'
                        ? x.authorLabel
                        : 'Someone';
                const authorUid =
                    typeof x.authorUid === 'string' ? x.authorUid : '';
                const del =
                    authorUid === user.uid
                        ? `<button type="button" class="btn-text btn-text--danger news-delete-btn" data-news-id="${d.id}">Delete</button>`
                        : '';
                return `<article class="news-item"><header class="news-item-header"><span class="news-item-author">${escapeHtml(author)}</span><span class="news-item-time">${escapeHtml(when)}</span>${del ? `<span class="news-item-actions">${del}</span>` : ''}</header><div class="news-item-body">${escapeHtml(body)}</div></article>`;
            })
            .join('');
    };

    const refreshMeetingsFromDocs = (docs: QueryDocumentSnapshot[]): void => {
        if (!meetingsListEl) {
            return;
        }
        if (docs.length === 0) {
            meetingsListEl.innerHTML =
                '<p class="meetings-list-empty">No meetings yet. Add one above.</p>';
            return;
        }
        meetingsListEl.innerHTML = docs
            .map((d) => {
                const x = d.data();
                const title =
                    typeof x.title === 'string' ? x.title.trim() : 'Meeting';
                const range = meetingRangeLabel(x.startAt, x.endAt);
                const organizer =
                    typeof x.organizerLabel === 'string'
                        ? x.organizerLabel
                        : 'Someone';
                const organizerUid =
                    typeof x.organizerUid === 'string' ? x.organizerUid : '';
                const locRaw =
                    typeof x.location === 'string' ? x.location.trim() : '';
                const urlRaw =
                    typeof x.meetingUrl === 'string' ? x.meetingUrl.trim() : '';
                const notesRaw =
                    typeof x.notes === 'string' ? x.notes.trim() : '';
                const locLine = locRaw
                    ? `<p class="meeting-item-meta">${escapeHtml(locRaw)}</p>`
                    : '';
                const safeMeetUrl = urlRaw ? safeHttpUrlForHref(urlRaw) : null;
                const urlLine = safeMeetUrl
                    ? `<p class="meeting-item-meta"><a href="${escapeHtml(safeMeetUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(urlRaw)}</a></p>`
                    : urlRaw
                      ? `<p class="meeting-item-meta">${escapeHtml(urlRaw)}</p>`
                      : '';
                const notesLine = notesRaw
                    ? `<div class="meeting-item-notes">${escapeHtml(notesRaw)}</div>`
                    : '';
                const canOrganize = organizerUid === user.uid;
                const actions = canOrganize
                    ? `<span class="meeting-item-actions"><button type="button" class="btn-text" data-meeting-edit="${escapeHtml(d.id)}">Edit</button><button type="button" class="btn-text btn-text--danger" data-meeting-delete="${escapeHtml(d.id)}">Delete</button></span>`
                    : '';
                return `<article class="meeting-item"><header class="meeting-item-header"><h4 class="meeting-item-title">${escapeHtml(title)}</h4>${actions}</header><p class="meeting-item-range">${escapeHtml(range)}</p><p class="meeting-item-organizer">Organizer: ${escapeHtml(organizer)}</p>${locLine}${urlLine}${notesLine}</article>`;
            })
            .join('');
    };

    const refreshDmThreadFromDocs = (docs: QueryDocumentSnapshot[]): void => {
        if (!dmThreadEl) {
            return;
        }
        if (docs.length === 0) {
            dmThreadEl.innerHTML =
                '<p class="dm-thread-empty">No messages in this conversation yet.</p>';
            return;
        }
        dmThreadEl.innerHTML = docs
            .map((d) => {
                const x = d.data();
                const fromUid =
                    typeof x.fromUid === 'string' ? x.fromUid : '';
                const body = typeof x.body === 'string' ? x.body : '';
                const when = auditTimestampLabel(x.createdAt);
                const mine = fromUid === user.uid;
                const rowClass = mine ? 'dm-row dm-row--mine' : 'dm-row dm-row--theirs';
                const who = mine
                    ? 'You'
                    : typeof x.fromLabel === 'string'
                      ? x.fromLabel
                      : 'Teammate';
                return `<div class="${rowClass}"><div class="dm-row-meta"><span class="dm-row-who">${escapeHtml(who)}</span><span class="dm-row-time">${escapeHtml(when)}</span></div><div class="dm-row-body">${escapeHtml(body)}</div></div>`;
            })
            .join('');
        dmThreadEl.scrollTop = dmThreadEl.scrollHeight;
    };

    const subscribeDmThread = (peerUid: string): void => {
        if (!companyContext || !dmThreadEl) {
            return;
        }
        const peer = peerUid.trim();
        dmThreadUnsubscribe?.();
        dmThreadUnsubscribe = null;
        dmSubscribedPeerUid = peer || null;
        if (!peer) {
            refreshDmThreadFromDocs([]);
            return;
        }
        const msgCol = collection(
            db,
            'companies',
            companyContext.companyId,
            MEMBER_MESSAGES_SUBCOLLECTION
        );
        const qOut = query(
            msgCol,
            where('fromUid', '==', user.uid),
            where('toUid', '==', peer),
            orderBy('createdAt', 'asc'),
            limit(DM_THREAD_QUERY_LIMIT)
        );
        const qIn = query(
            msgCol,
            where('fromUid', '==', peer),
            where('toUid', '==', user.uid),
            orderBy('createdAt', 'asc'),
            limit(DM_THREAD_QUERY_LIMIT)
        );
        let docsOut: QueryDocumentSnapshot[] = [];
        let docsIn: QueryDocumentSnapshot[] = [];
        const mergeThreadSnapshots = (): void => {
            refreshDmThreadFromDocs(
                mergeMemberMessageDocSnapshots(docsOut, docsIn)
            );
        };
        const onThreadSnapError = (err: Error): void => {
            console.error('DM thread listener error', err);
        };
        const unsubOut = onSnapshot(
            qOut,
            (snap) => {
                docsOut = snap.docs;
                mergeThreadSnapshots();
            },
            onThreadSnapError
        );
        const unsubIn = onSnapshot(
            qIn,
            (snap) => {
                docsIn = snap.docs;
                mergeThreadSnapshots();
            },
            onThreadSnapError
        );
        dmThreadUnsubscribe = () => {
            unsubOut();
            unsubIn();
        };
    };

    const refreshDmThreadFromServer = async (
        peerForThread: string
    ): Promise<void> => {
        const peer = peerForThread.trim();
        if (!companyContext || !dmThreadEl || !peer) {
            return;
        }
        const msgCol = collection(
            db,
            'companies',
            companyContext.companyId,
            MEMBER_MESSAGES_SUBCOLLECTION
        );
        const qOut = query(
            msgCol,
            where('fromUid', '==', user.uid),
            where('toUid', '==', peer),
            orderBy('createdAt', 'asc'),
            limit(DM_THREAD_QUERY_LIMIT)
        );
        const qIn = query(
            msgCol,
            where('fromUid', '==', peer),
            where('toUid', '==', user.uid),
            orderBy('createdAt', 'asc'),
            limit(DM_THREAD_QUERY_LIMIT)
        );
        try {
            const [outSnap, inSnap] = await Promise.all([
                getDocs(qOut),
                getDocs(qIn),
            ]);
            refreshDmThreadFromDocs(
                mergeMemberMessageDocSnapshots(outSnap.docs, inSnap.docs)
            );
        } catch (err) {
            console.error('DM thread server refresh failed', err);
        }
    };

    const fillDmRecipientOptions = (): void => {
        if (!dmPeerSelect) {
            return;
        }
        const prev = dmPeerSelect.value;
        dmPeerSelect.innerHTML = '';
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Choose teammate';
        dmPeerSelect.appendChild(placeholder);
        for (const e of latestEmployees) {
            if (e.uid === user.uid) {
                continue;
            }
            if ((e.status ?? 'active') === 'offboarded') {
                continue;
            }
            const opt = document.createElement('option');
            opt.value = e.uid;
            opt.textContent = memberDisplayName(e);
            dmPeerSelect.appendChild(opt);
        }
        const stillThere =
            Boolean(prev) &&
            [...dmPeerSelect.options].some((o) => o.value === prev);
        dmPeerSelect.value = stillThere ? prev : '';
        const selected = dmPeerSelect.value.trim();
        const subscribedFor = dmSubscribedPeerUid ?? '';
        if (selected !== subscribedFor) {
            subscribeDmThread(selected);
        }
    };

    const refreshDirectoryTable = (): void => {
        if (!companyContext || !directoryTbody) {
            return;
        }
        const q = (directorySearch?.value ?? '').trim().toLowerCase();
        let rows = [...latestEmployees].sort((a, b) =>
            memberDisplayName(a).localeCompare(
                memberDisplayName(b),
                undefined,
                { sensitivity: 'base' }
            )
        );
        if (q) {
            rows = rows.filter((e) => {
                const nm = memberDisplayName(e).toLowerCase();
                const em = (e.email ?? '').toLowerCase();
                const role = formatRoleForDisplay(e.role).toLowerCase();
                const st = (e.status ?? 'active').toLowerCase();
                const stLabel = statusDisplayLabel(
                    e.status ?? 'active'
                ).toLowerCase();
                const teamStr = (e.teamIds ?? [])
                    .map((id) => teamNameById(latestTeams, id).toLowerCase())
                    .join(' ');
                return (
                    nm.includes(q) ||
                    em.includes(q) ||
                    role.includes(q) ||
                    st.includes(q) ||
                    stLabel.includes(q) ||
                    teamStr.includes(q)
                );
            });
        }
        const canEdit = companyContext.canManageMembers;
        directoryTbody.innerHTML = rows
            .map((e) => {
                const name = escapeHtml(memberDisplayName(e));
                const email = escapeHtml(e.email?.trim() || '—');
                const role = escapeHtml(formatRoleForDisplay(e.role));
                const st = e.status ?? 'active';
                const stLabel = escapeHtml(statusDisplayLabel(st));
                let stClass = 'status-pill status-pill--active';
                if (st === 'suspended') {
                    stClass = 'status-pill status-pill--suspended';
                } else if (st === 'offboarded') {
                    stClass = 'status-pill status-pill--offboarded';
                }
                const teamLabels = (e.teamIds ?? [])
                    .map((id) => escapeHtml(teamNameById(latestTeams, id)))
                    .join(', ');
                const teamsCell = teamLabels || '—';
                const holidayCell = escapeHtml(
                    holidayStatusLabel(e.holidayDays ?? null)
                );
                const actionsCell = canEdit
                    ? `<button type="button" class="submit-btn submit-btn--table" data-member-edit="${escapeHtml(e.uid)}">Edit</button>`
                    : '—';
                return `<tr><td>${name}</td><td>${email}</td><td>${role}</td><td><span class="${stClass}">${stLabel}</span></td><td>${holidayCell}</td><td>${teamsCell}</td><td>${actionsCell}</td></tr>`;
            })
            .join('');
    };

    const csvCell = (value: string): string => {
        const needsQuotes = /[",\r\n]/.test(value);
        const escaped = value.replace(/"/g, '""');
        return needsQuotes ? `"${escaped}"` : escaped;
    };

    const exportDirectoryCsv = (): void => {
        if (!companyContext) {
            return;
        }
        const header = [
            'Name',
            'Email',
            'Role',
            'Status',
            'Holiday status',
            'Teams',
        ];
        const rows = [...latestEmployees]
            .sort((a, b) =>
                memberDisplayName(a).localeCompare(
                    memberDisplayName(b),
                    undefined,
                    {
                        sensitivity: 'base',
                    }
                )
            )
            .map((emp) => {
                const teams = (emp.teamIds ?? [])
                    .map((id) => teamNameById(latestTeams, id))
                    .join(', ');
                return [
                    memberDisplayName(emp),
                    emp.email?.trim() || '',
                    formatRoleForDisplay(emp.role),
                    statusDisplayLabel(emp.status ?? 'active'),
                    holidayStatusLabel(emp.holidayDays ?? null),
                    teams,
                ];
            });
        const csv = [header, ...rows]
            .map((row) => row.map((value) => csvCell(String(value))).join(','))
            .join('\r\n');
        const blob = new Blob([`\uFEFF${csv}`], {
            type: 'text/csv;charset=utf-8;',
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const safeCompanyName = companyContext.companyName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
        const dateStamp = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `${safeCompanyName || 'company'}-directory-${dateStamp}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    };

    const refreshTeamList = (): void => {
        if (!teamListEl || !companyContext) {
            return;
        }
        const manage = companyContext.canManageMembers;
        if (latestTeams.length === 0) {
            teamListEl.innerHTML =
                '<li class="team-list-empty">No teams yet. Add one below if you manage teams.</li>';
            return;
        }
        teamListEl.innerHTML = latestTeams
            .map((t) => {
                const actions = manage
                    ? `<span class="team-row-actions"><button type="button" class="btn-text" data-team-rename="${escapeHtml(t.id)}">Rename</button><button type="button" class="btn-text btn-text--danger" data-team-delete="${escapeHtml(t.id)}">Delete</button></span>`
                    : '';
                return `<li class="team-row"><span class="team-row-name">${escapeHtml(t.name)}</span>${actions}</li>`;
            })
            .join('');
    };

    const inviteStatusMeta = (
        docSnap: QueryDocumentSnapshot
    ): {
        statusLabel: string;
        statusClass: string;
        canRevoke: boolean;
        canExtend: boolean;
    } => {
        const invite = docSnap.data();
        const used = invite.used === true;
        const expiresAt =
            invite.expiresAt instanceof Timestamp ? invite.expiresAt : null;
        const expired = Boolean(expiresAt && expiresAt.toMillis() <= Date.now());
        if (used) {
            return {
                statusLabel: 'Used',
                statusClass: 'status-pill status-pill--offboarded',
                canRevoke: false,
                canExtend: false,
            };
        }
        if (expired) {
            return {
                statusLabel: 'Expired',
                statusClass: 'status-pill status-pill--suspended',
                canRevoke: false,
                canExtend: true,
            };
        }
        return {
            statusLabel: 'Pending',
            statusClass: 'status-pill status-pill--active',
            canRevoke: true,
            canExtend: true,
        };
    };

    const refreshInviteManageList = (): void => {
        if (!inviteManageList) {
            return;
        }
        if (!companyContext) {
            inviteManageList.innerHTML =
                '<p class="meeting-empty">No company workspace found.</p>';
            return;
        }
        if (latestInviteDocs.length === 0) {
            inviteManageList.innerHTML =
                '<p class="meeting-empty">No invitations yet.</p>';
            return;
        }
        inviteManageList.innerHTML = latestInviteDocs
            .map((docSnap) => {
                const invite = docSnap.data();
                const inviteeName =
                    typeof invite.inviteeName === 'string' &&
                    invite.inviteeName.trim()
                        ? invite.inviteeName.trim()
                        : 'Unnamed person';
                const roleRaw =
                    typeof invite.role === 'string' ? invite.role.trim() : '';
                const role = roleRaw
                    ? formatRoleForDisplay(roleRaw)
                    : 'Unspecified role';
                const createdAtLabel = auditTimestampLabel(invite.createdAt);
                const expiresAtLabel = auditTimestampLabel(invite.expiresAt);
                const statusMeta = inviteStatusMeta(docSnap);
                const disableActions = inviteManageActionBusy
                    ? ' disabled aria-disabled="true"'
                    : '';
                const revokeBtn = statusMeta.canRevoke
                    ? `<button type="button" class="btn-text btn-text--danger" data-invite-revoke="${escapeHtml(docSnap.id)}"${disableActions}>Revoke</button>`
                    : '';
                const extendBtn = statusMeta.canExtend
                    ? `<button type="button" class="btn-text" data-invite-extend="${escapeHtml(docSnap.id)}"${disableActions}>Resend / extend</button>`
                    : '';
                const copyBtn = `<button type="button" class="btn-text" data-invite-copy="${escapeHtml(docSnap.id)}"${disableActions}>Copy ID</button>`;
                const actions = [copyBtn, extendBtn, revokeBtn]
                    .filter(Boolean)
                    .join('');
                return `<article class="meeting-item"><header class="meeting-item-header"><h4 class="meeting-item-title">${escapeHtml(inviteeName)}</h4><span class="${statusMeta.statusClass}">${escapeHtml(statusMeta.statusLabel)}</span></header><p class="meeting-item-meta">Role: ${escapeHtml(role)}</p><p class="meeting-item-meta">Created: ${escapeHtml(createdAtLabel)} | Expires: ${escapeHtml(expiresAtLabel)}</p><p class="meeting-item-meta">Invite ID: <code>${escapeHtml(docSnap.id)}</code></p><p class="team-row-actions">${actions}</p></article>`;
            })
            .join('');
    };

    const refreshHolidayManageGrid = (): void => {
        if (!holidayManageGrid || !companyContext || !companyContext.isOwner) {
            return;
        }
        const rows = [...latestEmployees].sort((a, b) =>
            memberDisplayName(a).localeCompare(
                memberDisplayName(b),
                undefined,
                {
                    sensitivity: 'base',
                }
            )
        );
        holidayManageGrid.innerHTML = rows
            .map((emp) => {
                const name = escapeHtml(memberDisplayName(emp));
                const email = escapeHtml(emp.email?.trim() || 'No email');
                const value =
                    typeof emp.holidayDays === 'number'
                        ? String(Math.max(0, Math.floor(emp.holidayDays)))
                        : '';
                return `<div class="holiday-manage-row"><div class="holiday-manage-person"><strong>${name}</strong><span>${email}</span></div><input type="number" class="form-input holiday-manage-input" min="0" step="1" value="${value}" data-holiday-uid="${escapeHtml(emp.uid)}" placeholder="0" /></div>`;
            })
            .join('');
    };

    const refreshHolidayRequestAvailability = (): void => {
        if (!companyContext || !holidayRequestForm || !holidayBalanceMessage) {
            return;
        }
        const me = latestEmployees.find((emp) => emp.uid === user.uid);
        const hasAllowance =
            typeof me?.holidayDays === 'number' &&
            Number.isFinite(me.holidayDays);
        holidayRequestForm.hidden = !hasAllowance;
        if (!hasAllowance) {
            holidayBalanceMessage.textContent =
                'Your owner has not set your holiday allowance yet.';
            return;
        }
        holidayBalanceMessage.textContent = `You currently have ${holidayStatusLabel(
            me?.holidayDays ?? null
        )}.`;
    };

    const refreshHolidayRequestsList = (
        docs: QueryDocumentSnapshot[]
    ): void => {
        if (!holidayRequestsListEl) {
            return;
        }
        const items = docs
            .map((d) => normalizeHolidayRequest(d.id, d.data()))
            .filter((x): x is HolidayRequestRecord => x !== null);
        if (items.length === 0) {
            holidayRequestsListEl.innerHTML =
                '<li class="audit-log-empty">No holiday requests yet.</li>';
            return;
        }
        holidayRequestsListEl.innerHTML = items
            .map((item) => {
                const when = auditTimestampLabel(item.createdAt);
                const state =
                    item.status === 'approved'
                        ? 'Approved'
                        : item.status === 'rejected'
                          ? 'Rejected'
                          : 'Pending';
                const actions =
                    item.status === 'pending'
                        ? `<span class="team-row-actions"><button type="button" class="btn-text" data-holiday-approve="${escapeHtml(item.id)}">Approve</button><button type="button" class="btn-text btn-text--danger" data-holiday-reject="${escapeHtml(item.id)}">Reject</button></span>`
                        : '';
                const resolved =
                    item.status === 'pending'
                        ? ''
                        : `<div class="audit-log-detail">Updated: ${escapeHtml(
                              auditTimestampLabel(item.resolvedAt)
                          )}</div>`;
                return `<li class="audit-log-item"><div class="audit-log-meta"><span class="audit-log-time">${escapeHtml(
                    when
                )}</span><span class="audit-log-actor">${escapeHtml(
                    item.requesterLabel
                )}</span></div><div class="audit-log-summary">${escapeHtml(
                    `${item.days} day${item.days === 1 ? '' : 's'} requested · ${state}`
                )}</div>${resolved}${actions}</li>`;
            })
            .join('');
    };

    const refreshTransferOwnershipOptions = (): void => {
        if (!transferOwnershipSelect || !companyContext?.isOwner) {
            return;
        }
        const candidates = latestEmployees
            .filter(
                (emp) =>
                    emp.uid !== companyContext.ownerUid &&
                    (emp.status ?? 'active') !== 'offboarded'
            )
            .sort((a, b) =>
                memberDisplayName(a).localeCompare(
                    memberDisplayName(b),
                    undefined,
                    {
                        sensitivity: 'base',
                    }
                )
            );
        transferOwnershipSelect.innerHTML =
            '<option value="">Choose a member</option>' +
            candidates
                .map((emp) => {
                    const name = escapeHtml(memberDisplayName(emp));
                    const email = escapeHtml(emp.email?.trim() || 'No email');
                    return `<option value="${escapeHtml(emp.uid)}">${name} · ${email}</option>`;
                })
                .join('');
    };

    const closeMemberEditModal = (): void => {
        if (memberEditModalEl) {
            memberEditModalEl.hidden = true;
        }
        editingMemberUid = null;
        if (memberEditMessageEl) {
            memberEditMessageEl.textContent = '';
            memberEditMessageEl.classList.remove('success', 'error');
        }
    };

    const openMemberEditModal = (emp: CompanyEmployee): void => {
        if (
            !companyContext ||
            !memberEditModalEl ||
            !memberEditSubtitleEl ||
            !memberEditRoleSelect ||
            !memberEditStatusSelect ||
            !memberEditTeamsEl
        ) {
            return;
        }
        editingMemberUid = emp.uid;
        memberEditModalEl.hidden = false;
        const sub = memberDisplayName(emp);
        memberEditSubtitleEl.textContent = emp.email?.trim()
            ? `${sub} · ${emp.email.trim()}`
            : sub;
        const opts = roleOptionsForMemberEdit(
            emp,
            latestInviteRoleEntries,
            companyContext.ownerUid
        );
        memberEditRoleSelect.innerHTML = opts
            .map((o) => {
                const v = escapeHtml(o.name);
                const lab = escapeHtml(formatRoleForDisplay(o.name));
                return `<option value="${v}">${lab}</option>`;
            })
            .join('');
        memberEditRoleSelect.value = emp.role;
        const isOwnerRow = emp.uid === companyContext.ownerUid;
        memberEditRoleSelect.disabled = isOwnerRow;
        memberEditStatusSelect.value = emp.status ?? 'active';
        memberEditStatusSelect.disabled = isOwnerRow;
        if (isOwnerRow) {
            memberEditStatusSelect.value = 'active';
        }
        if (latestTeams.length === 0) {
            memberEditTeamsEl.innerHTML =
                '<p class="dash-text-muted">No teams yet. Add teams in the section above.</p>';
        } else {
            memberEditTeamsEl.innerHTML = latestTeams
                .map((t) => {
                    const checked = (emp.teamIds ?? []).includes(t.id)
                        ? ' checked'
                        : '';
                    return `<label class="dash-checkbox-label member-team-label"><input type="checkbox" value="${escapeHtml(t.id)}"${checked} />${escapeHtml(t.name)}</label>`;
                })
                .join('');
        }
        if (memberEditMessageEl) {
            memberEditMessageEl.textContent = '';
            memberEditMessageEl.classList.remove('success', 'error');
        }
    };

    if (companyContext && directoryTbody) {
        refreshDirectoryTable();
        directorySearch?.addEventListener('input', () => {
            refreshDirectoryTable();
        });
        directoryExportBtn?.addEventListener('click', () => {
            exportDirectoryCsv();
        });
        directoryTbody.addEventListener('click', (ev) => {
            const btn = (ev.target as HTMLElement).closest(
                '[data-member-edit]'
            ) as HTMLButtonElement | null;
            if (!btn) {
                return;
            }
            const uid = btn.getAttribute('data-member-edit');
            const emp = latestEmployees.find((x) => x.uid === uid);
            if (emp) {
                openMemberEditModal(emp);
            }
        });
    }

    if (
        companyContext &&
        companyContext.canManageMembers &&
        teamListEl &&
        newTeamNameInput &&
        addTeamBtn &&
        teamFormMessage
    ) {
        refreshTeamList();
        addTeamBtn.addEventListener('click', async () => {
            const name = newTeamNameInput.value.trim();
            teamFormMessage.classList.remove('success', 'error');
            if (!name) {
                teamFormMessage.textContent = 'Enter a team name first.';
                teamFormMessage.classList.add('error');
                return;
            }
            const companyRef = doc(db, 'companies', companyContext.companyId);
            addTeamBtn.disabled = true;
            teamFormMessage.textContent = '';
            try {
                const snap = await getDoc(companyRef);
                const current = normalizeTeams(snap.data()?.teams);
                if (
                    current.some(
                        (t) => t.name.toLowerCase() === name.toLowerCase()
                    )
                ) {
                    teamFormMessage.textContent =
                        'A team with that name already exists.';
                    teamFormMessage.classList.add('error');
                    return;
                }
                const id = (
                    globalThis.crypto as Crypto & { randomUUID(): string }
                ).randomUUID();
                const next = [...current, { id, name }];
                await updateDoc(companyRef, { teams: next });
                newTeamNameInput.value = '';
                teamFormMessage.textContent = 'Team added.';
                teamFormMessage.classList.add('success');
                const actorLabel =
                    user.displayName?.trim() ||
                    user.email?.split('@')[0] ||
                    'User';
                try {
                    await appendAuditEvent(companyContext.companyId, {
                        actorUid: user.uid,
                        actorLabel,
                        action: 'team_created',
                        summary: `Team "${name}" was added`,
                    });
                } catch {
                    /* best-effort */
                }
            } catch (err) {
                teamFormMessage.textContent = friendlyFirestoreError(
                    err,
                    'Could not add that team. Try again.'
                );
                teamFormMessage.classList.add('error');
            } finally {
                addTeamBtn.disabled = false;
            }
        });

        teamListEl.addEventListener('click', async (ev) => {
            const renameBtn = (ev.target as HTMLElement).closest(
                'button[data-team-rename]'
            ) as HTMLButtonElement | null;
            const deleteBtn = (ev.target as HTMLElement).closest(
                'button[data-team-delete]'
            ) as HTMLButtonElement | null;
            const companyRef = doc(db, 'companies', companyContext.companyId);
            const actorLabel =
                user.displayName?.trim() || user.email?.split('@')[0] || 'User';

            if (renameBtn) {
                const tid = renameBtn.getAttribute('data-team-rename');
                const team = latestTeams.find((x) => x.id === tid);
                if (!tid || !team) {
                    return;
                }
                const proposed = window.prompt('Rename team', team.name);
                if (proposed === null) {
                    return;
                }
                const newName = proposed.trim();
                if (!newName || newName === team.name) {
                    return;
                }
                try {
                    const snap = await getDoc(companyRef);
                    const teams = normalizeTeams(snap.data()?.teams);
                    if (
                        teams.some(
                            (t) =>
                                t.id !== tid &&
                                t.name.toLowerCase() === newName.toLowerCase()
                        )
                    ) {
                        window.alert('Another team already uses that name.');
                        return;
                    }
                    const next = teams.map((t) =>
                        t.id === tid ? { ...t, name: newName } : t
                    );
                    await updateDoc(companyRef, { teams: next });
                    try {
                        await appendAuditEvent(companyContext.companyId, {
                            actorUid: user.uid,
                            actorLabel,
                            action: 'team_renamed',
                            summary: `Team renamed from "${team.name}" to "${newName}"`,
                        });
                    } catch {
                        /* best-effort */
                    }
                } catch (err) {
                    window.alert(friendlyFirestoreError(err, 'Rename failed.'));
                }
                return;
            }

            if (deleteBtn) {
                const tid = deleteBtn.getAttribute('data-team-delete');
                const team = latestTeams.find((x) => x.id === tid);
                if (!tid || !team) {
                    return;
                }
                if (
                    !window.confirm(
                        `Remove team "${team.name}"? People will be unassigned from it.`
                    )
                ) {
                    return;
                }
                try {
                    const snap = await getDoc(companyRef);
                    const teams = normalizeTeams(snap.data()?.teams);
                    const employees = normalizeEmployeeList(
                        snap.data()?.employees
                    );
                    const nextTeams = teams.filter((t) => t.id !== tid);
                    const nextEmployees = employees.map((e) => ({
                        ...e,
                        teamIds: (e.teamIds ?? []).filter((x) => x !== tid),
                    }));
                    await updateDoc(companyRef, {
                        teams: nextTeams,
                        employees: nextEmployees,
                    });
                    try {
                        await appendAuditEvent(companyContext.companyId, {
                            actorUid: user.uid,
                            actorLabel,
                            action: 'team_deleted',
                            summary: `Team "${team.name}" was removed`,
                        });
                    } catch {
                        /* best-effort */
                    }
                } catch (err) {
                    window.alert(friendlyFirestoreError(err, 'Delete failed.'));
                }
            }
        });
    } else if (companyContext && teamListEl) {
        refreshTeamList();
    }

    if (
        companyContext &&
        memberEditModalEl &&
        memberEditFormEl &&
        memberEditRoleSelect &&
        memberEditStatusSelect &&
        memberEditTeamsEl &&
        memberEditMessageEl &&
        memberEditCancelBtn &&
        memberEditSaveBtn &&
        companyContext.canManageMembers
    ) {
        memberEditCancelBtn.addEventListener('click', () =>
            closeMemberEditModal()
        );
        memberEditModalEl.addEventListener('click', (e) => {
            if (e.target === memberEditModalEl) {
                closeMemberEditModal();
            }
        });
        memberEditFormEl.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!editingMemberUid) {
                return;
            }
            memberEditMessageEl.classList.remove('success', 'error');
            memberEditMessageEl.textContent = '';
            const companyRef = doc(db, 'companies', companyContext.companyId);
            memberEditSaveBtn.disabled = true;
            try {
                const snap = await getDoc(companyRef);
                const employees = normalizeEmployeeList(snap.data()?.employees);
                const before = employees.find(
                    (x) => x.uid === editingMemberUid
                );
                if (!before) {
                    memberEditMessageEl.textContent =
                        'That person is no longer in the company.';
                    memberEditMessageEl.classList.add('error');
                    return;
                }
                let newRole = memberEditRoleSelect.value;
                let newStatus = memberEditStatusSelect.value as EmployeeStatus;
                const checked = memberEditTeamsEl.querySelectorAll(
                    'input[type="checkbox"]:checked'
                );
                const newTeamIds = Array.from(checked).map(
                    (c) => (c as HTMLInputElement).value
                );
                if (before.uid === companyContext.ownerUid) {
                    newRole = 'owner';
                    newStatus = 'active';
                }
                const next = employees.map((emp) =>
                    emp.uid === editingMemberUid
                        ? {
                              ...emp,
                              role: newRole,
                              status: newStatus,
                              teamIds: newTeamIds,
                          }
                        : emp
                );
                await updateDoc(companyRef, { employees: next });
                const actorLabel =
                    user.displayName?.trim() ||
                    user.email?.split('@')[0] ||
                    'User';
                const targetName = memberDisplayName(before);
                if (before.role !== newRole) {
                    try {
                        await appendAuditEvent(companyContext.companyId, {
                            actorUid: user.uid,
                            actorLabel,
                            action: 'member_role_changed',
                            summary: `Updated ${targetName}'s role to ${formatRoleForDisplay(newRole)}`,
                            detail: `Previous: ${formatRoleForDisplay(before.role)}`,
                        });
                    } catch {
                        /* best-effort */
                    }
                }
                if ((before.status ?? 'active') !== newStatus) {
                    try {
                        await appendAuditEvent(companyContext.companyId, {
                            actorUid: user.uid,
                            actorLabel,
                            action: 'member_status_changed',
                            summary: `Updated ${targetName}'s status to ${statusDisplayLabel(newStatus)}`,
                            detail: `Previous: ${statusDisplayLabel(before.status ?? 'active')}`,
                        });
                    } catch {
                        /* best-effort */
                    }
                }
                if (!teamIdsEqual(before.teamIds ?? [], newTeamIds)) {
                    const fmt = (ids: string[]) =>
                        ids.length === 0
                            ? 'None'
                            : ids
                                  .map((id) => teamNameById(latestTeams, id))
                                  .join(', ');
                    try {
                        await appendAuditEvent(companyContext.companyId, {
                            actorUid: user.uid,
                            actorLabel,
                            action: 'member_teams_changed',
                            summary: `Updated teams for ${targetName}`,
                            detail: `Before: ${fmt(before.teamIds ?? [])}; after: ${fmt(newTeamIds)}`,
                        });
                    } catch {
                        /* best-effort */
                    }
                }
                closeMemberEditModal();
            } catch (err) {
                memberEditMessageEl.textContent = friendlyFirestoreError(
                    err,
                    'Could not save changes.'
                );
                memberEditMessageEl.classList.add('error');
            } finally {
                memberEditSaveBtn.disabled = false;
            }
        });
    }

    if (
        companyContext &&
        newsPostForm &&
        newsBodyInput &&
        newsPostBtn &&
        newsPostMessage &&
        companyNewsListEl
    ) {
        newsPostForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const body = newsBodyInput.value.trim();
            newsPostMessage.classList.remove('success', 'error');
            newsPostMessage.textContent = '';
            if (!body) {
                newsPostMessage.textContent = 'Write something before posting.';
                newsPostMessage.classList.add('error');
                return;
            }
            const actorLabel =
                user.displayName?.trim() ||
                user.email?.split('@')[0] ||
                'Member';
            newsPostBtn.disabled = true;
            try {
                await addDoc(
                    collection(
                        db,
                        'companies',
                        companyContext.companyId,
                        COMPANY_NEWS_SUBCOLLECTION
                    ),
                    {
                        authorUid: user.uid,
                        authorLabel: actorLabel,
                        body,
                        createdAt: serverTimestamp(),
                    }
                );
                const preview =
                    body.length > 180 ? `${body.slice(0, 180).trim()}…` : body;
                try {
                    await appendAuditEvent(companyContext.companyId, {
                        actorUid: user.uid,
                        actorLabel,
                        action: 'news_posted',
                        summary: `${actorLabel} posted company news`,
                        detail: preview,
                    });
                } catch {
                    /* best-effort */
                }
                newsBodyInput.value = '';
                newsPostMessage.textContent = 'Posted.';
                newsPostMessage.classList.add('success');
            } catch (err) {
                newsPostMessage.textContent = friendlyFirestoreError(
                    err,
                    'Could not post. Try again.'
                );
                newsPostMessage.classList.add('error');
            } finally {
                newsPostBtn.disabled = false;
            }
        });

        companyNewsListEl.addEventListener('click', async (ev) => {
            const btn = (ev.target as HTMLElement).closest(
                'button[data-news-id]'
            ) as HTMLButtonElement | null;
            if (!btn) {
                return;
            }
            const id = btn.getAttribute('data-news-id');
            if (!id || !window.confirm('Remove this post from company news?')) {
                return;
            }
            const newsRef = doc(
                db,
                'companies',
                companyContext.companyId,
                COMPANY_NEWS_SUBCOLLECTION,
                id
            );
            try {
                const snap = await getDoc(newsRef);
                if (!snap.exists()) {
                    window.alert('That post is already gone.');
                    return;
                }
                const data = snap.data();
                const prevBody =
                    typeof data?.body === 'string' ? data.body : '';
                await deleteDoc(newsRef);
                const delActorLabel =
                    user.displayName?.trim() ||
                    user.email?.split('@')[0] ||
                    'Member';
                const delPreview =
                    prevBody.length > 180
                        ? `${prevBody.slice(0, 180).trim()}…`
                        : prevBody;
                try {
                    await appendAuditEvent(companyContext.companyId, {
                        actorUid: user.uid,
                        actorLabel: delActorLabel,
                        action: 'news_deleted',
                        summary: `${delActorLabel} removed a company news post`,
                        detail: delPreview || undefined,
                    });
                } catch {
                    /* best-effort */
                }
            } catch (err) {
                window.alert(
                    friendlyFirestoreError(err, 'Could not delete that post.')
                );
            }
        });
    }

    const closeMeetingEditModal = (): void => {
        editingMeetingId = null;
        if (meetingEditModalEl) {
            meetingEditModalEl.hidden = true;
        }
        if (meetingEditFormEl) {
            meetingEditFormEl.reset();
        }
        if (meetingEditMessageEl) {
            meetingEditMessageEl.textContent = '';
            meetingEditMessageEl.classList.remove('success', 'error');
        }
    };

    if (
        companyContext &&
        meetingCreateForm &&
        meetingTitleInput &&
        meetingStartInput &&
        meetingEndInput &&
        meetingCreateBtn &&
        meetingCreateMessage &&
        meetingsListEl
    ) {
        meetingCreateForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            meetingCreateMessage.classList.remove('success', 'error');
            meetingCreateMessage.textContent = '';
            const title = meetingTitleInput.value.trim();
            if (!title) {
                meetingCreateMessage.textContent = 'Enter a meeting title.';
                meetingCreateMessage.classList.add('error');
                return;
            }
            const startD = parseDatetimeLocalToDate(meetingStartInput.value);
            const endD = parseDatetimeLocalToDate(meetingEndInput.value);
            if (!startD || !endD) {
                meetingCreateMessage.textContent =
                    'Choose valid start and end times.';
                meetingCreateMessage.classList.add('error');
                return;
            }
            if (endD.getTime() <= startD.getTime()) {
                meetingCreateMessage.textContent =
                    'End time must be after start time.';
                meetingCreateMessage.classList.add('error');
                return;
            }
            const loc = meetingLocationInput?.value.trim() ?? '';
            const urlRaw = meetingUrlInput?.value.trim() ?? '';
            const notes = meetingNotesInput?.value.trim() ?? '';
            if (loc.length > MEETING_LOCATION_MAX_LENGTH) {
                meetingCreateMessage.textContent = 'Location is too long.';
                meetingCreateMessage.classList.add('error');
                return;
            }
            if (urlRaw.length > MEETING_URL_MAX_LENGTH) {
                meetingCreateMessage.textContent = 'Video link is too long.';
                meetingCreateMessage.classList.add('error');
                return;
            }
            if (notes.length > MEETING_NOTES_MAX_LENGTH) {
                meetingCreateMessage.textContent = 'Notes are too long.';
                meetingCreateMessage.classList.add('error');
                return;
            }
            const actorLabel =
                user.displayName?.trim() ||
                user.email?.split('@')[0] ||
                'Member';
            meetingCreateBtn.disabled = true;
            try {
                await addDoc(
                    collection(
                        db,
                        'companies',
                        companyContext.companyId,
                        MEETINGS_SUBCOLLECTION
                    ),
                    {
                        organizerUid: user.uid,
                        organizerLabel: actorLabel,
                        title,
                        startAt: Timestamp.fromDate(startD),
                        endAt: Timestamp.fromDate(endD),
                        location: loc || null,
                        meetingUrl: urlRaw || null,
                        notes: notes || null,
                        createdAt: serverTimestamp(),
                    }
                );
                try {
                    await appendAuditEvent(companyContext.companyId, {
                        actorUid: user.uid,
                        actorLabel,
                        action: 'meeting_created',
                        summary: `${actorLabel} scheduled a meeting`,
                        detail: title,
                    });
                } catch {
                    /* best-effort */
                }
                meetingCreateForm.reset();
                meetingCreateMessage.textContent = 'Meeting added.';
                meetingCreateMessage.classList.add('success');
            } catch (err) {
                meetingCreateMessage.textContent = friendlyFirestoreError(
                    err,
                    'Could not save the meeting. Try again.'
                );
                meetingCreateMessage.classList.add('error');
            } finally {
                meetingCreateBtn.disabled = false;
            }
        });

        meetingsListEl.addEventListener('click', async (ev) => {
            const delBtn = (ev.target as HTMLElement).closest(
                'button[data-meeting-delete]'
            ) as HTMLButtonElement | null;
            const editBtn = (ev.target as HTMLElement).closest(
                'button[data-meeting-edit]'
            ) as HTMLButtonElement | null;
            if (delBtn) {
                const id = delBtn.getAttribute('data-meeting-delete');
                if (!id || !window.confirm('Delete this meeting?')) {
                    return;
                }
                const meetingRef = doc(
                    db,
                    'companies',
                    companyContext.companyId,
                    MEETINGS_SUBCOLLECTION,
                    id
                );
                try {
                    const snap = await getDoc(meetingRef);
                    if (!snap.exists()) {
                        window.alert('That meeting is already gone.');
                        return;
                    }
                    const md = snap.data();
                    const prevTitle =
                        typeof md.title === 'string' ? md.title : '';
                    await deleteDoc(meetingRef);
                    const actorLabel =
                        user.displayName?.trim() ||
                        user.email?.split('@')[0] ||
                        'Member';
                    try {
                        await appendAuditEvent(companyContext.companyId, {
                            actorUid: user.uid,
                            actorLabel,
                            action: 'meeting_deleted',
                            summary: `${actorLabel} deleted a meeting`,
                            detail: prevTitle || undefined,
                        });
                    } catch {
                        /* best-effort */
                    }
                } catch (err) {
                    window.alert(
                        friendlyFirestoreError(
                            err,
                            'Could not delete that meeting.'
                        )
                    );
                }
                return;
            }
            if (
                editBtn &&
                meetingEditModalEl &&
                meetingEditFormEl &&
                meetingEditTitleInput &&
                meetingEditStartInput &&
                meetingEditEndInput &&
                meetingEditLocationInput &&
                meetingEditUrlInput &&
                meetingEditNotesInput &&
                meetingEditMessageEl
            ) {
                const id = editBtn.getAttribute('data-meeting-edit');
                if (!id) {
                    return;
                }
                const meetingRef = doc(
                    db,
                    'companies',
                    companyContext.companyId,
                    MEETINGS_SUBCOLLECTION,
                    id
                );
                try {
                    const snap = await getDoc(meetingRef);
                    if (!snap.exists()) {
                        window.alert('That meeting no longer exists.');
                        return;
                    }
                    const data = snap.data();
                    const orgUid =
                        typeof data.organizerUid === 'string'
                            ? data.organizerUid
                            : '';
                    if (orgUid !== user.uid) {
                        window.alert(
                            'Only the organizer can edit this meeting.'
                        );
                        return;
                    }
                    editingMeetingId = id;
                    meetingEditTitleInput.value =
                        typeof data.title === 'string' ? data.title : '';
                    const s =
                        data.startAt instanceof Timestamp
                            ? data.startAt.toDate()
                            : null;
                    const en =
                        data.endAt instanceof Timestamp
                            ? data.endAt.toDate()
                            : null;
                    meetingEditStartInput.value = s
                        ? toDatetimeLocalValue(s)
                        : '';
                    meetingEditEndInput.value = en
                        ? toDatetimeLocalValue(en)
                        : '';
                    meetingEditLocationInput.value =
                        typeof data.location === 'string' ? data.location : '';
                    meetingEditUrlInput.value =
                        typeof data.meetingUrl === 'string'
                            ? data.meetingUrl
                            : '';
                    meetingEditNotesInput.value =
                        typeof data.notes === 'string' ? data.notes : '';
                    meetingEditMessageEl.textContent = '';
                    meetingEditMessageEl.classList.remove('success', 'error');
                    meetingEditModalEl.hidden = false;
                } catch (err) {
                    window.alert(
                        friendlyFirestoreError(
                            err,
                            'Could not open that meeting.'
                        )
                    );
                }
            }
        });
    }

    if (
        companyContext &&
        meetingEditFormEl &&
        meetingEditTitleInput &&
        meetingEditStartInput &&
        meetingEditEndInput &&
        meetingEditLocationInput &&
        meetingEditUrlInput &&
        meetingEditNotesInput &&
        meetingEditSaveBtn &&
        meetingEditMessageEl
    ) {
        meetingEditFormEl.addEventListener('submit', async (e) => {
            e.preventDefault();
            if (!editingMeetingId) {
                return;
            }
            meetingEditMessageEl.classList.remove('success', 'error');
            meetingEditMessageEl.textContent = '';
            const title = meetingEditTitleInput.value.trim();
            if (!title) {
                meetingEditMessageEl.textContent = 'Enter a meeting title.';
                meetingEditMessageEl.classList.add('error');
                return;
            }
            const startD = parseDatetimeLocalToDate(
                meetingEditStartInput.value
            );
            const endD = parseDatetimeLocalToDate(meetingEditEndInput.value);
            if (!startD || !endD) {
                meetingEditMessageEl.textContent =
                    'Choose valid start and end times.';
                meetingEditMessageEl.classList.add('error');
                return;
            }
            if (endD.getTime() <= startD.getTime()) {
                meetingEditMessageEl.textContent =
                    'End time must be after start time.';
                meetingEditMessageEl.classList.add('error');
                return;
            }
            const loc = meetingEditLocationInput.value.trim();
            const urlRaw = meetingEditUrlInput.value.trim();
            const notes = meetingEditNotesInput.value.trim();
            if (loc.length > MEETING_LOCATION_MAX_LENGTH) {
                meetingEditMessageEl.textContent = 'Location is too long.';
                meetingEditMessageEl.classList.add('error');
                return;
            }
            if (urlRaw.length > MEETING_URL_MAX_LENGTH) {
                meetingEditMessageEl.textContent = 'Video link is too long.';
                meetingEditMessageEl.classList.add('error');
                return;
            }
            if (notes.length > MEETING_NOTES_MAX_LENGTH) {
                meetingEditMessageEl.textContent = 'Notes are too long.';
                meetingEditMessageEl.classList.add('error');
                return;
            }
            const meetingRef = doc(
                db,
                'companies',
                companyContext.companyId,
                MEETINGS_SUBCOLLECTION,
                editingMeetingId
            );
            meetingEditSaveBtn.disabled = true;
            try {
                const snap = await getDoc(meetingRef);
                if (!snap.exists()) {
                    meetingEditMessageEl.textContent =
                        'This meeting was removed. Close and refresh.';
                    meetingEditMessageEl.classList.add('error');
                    return;
                }
                const prev = snap.data();
                if (
                    typeof prev.organizerUid !== 'string' ||
                    prev.organizerUid !== user.uid
                ) {
                    meetingEditMessageEl.textContent =
                        'You can no longer edit this meeting.';
                    meetingEditMessageEl.classList.add('error');
                    return;
                }
                await updateDoc(meetingRef, {
                    title,
                    startAt: Timestamp.fromDate(startD),
                    endAt: Timestamp.fromDate(endD),
                    location: loc || null,
                    meetingUrl: urlRaw || null,
                    notes: notes || null,
                    updatedAt: serverTimestamp(),
                });
                const actorLabel =
                    user.displayName?.trim() ||
                    user.email?.split('@')[0] ||
                    'Member';
                try {
                    await appendAuditEvent(companyContext.companyId, {
                        actorUid: user.uid,
                        actorLabel,
                        action: 'meeting_updated',
                        summary: `${actorLabel} updated a meeting`,
                        detail: title,
                    });
                } catch {
                    /* best-effort */
                }
                closeMeetingEditModal();
            } catch (err) {
                meetingEditMessageEl.textContent = friendlyFirestoreError(
                    err,
                    'Could not save changes.'
                );
                meetingEditMessageEl.classList.add('error');
            } finally {
                meetingEditSaveBtn.disabled = false;
            }
        });
    }

    if (meetingEditCancelBtn) {
        meetingEditCancelBtn.addEventListener('click', () => {
            closeMeetingEditModal();
        });
    }

    if (
        companyContext &&
        holidayRequestForm &&
        holidayRequestDaysInput &&
        holidayRequestBtn &&
        holidayRequestMessage
    ) {
        refreshHolidayRequestAvailability();
        holidayRequestForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            holidayRequestMessage.textContent = '';
            holidayRequestMessage.classList.remove('success', 'error');
            const me = latestEmployees.find((emp) => emp.uid === user.uid);
            if (
                !me ||
                typeof me.holidayDays !== 'number' ||
                !Number.isFinite(me.holidayDays)
            ) {
                holidayRequestMessage.textContent =
                    'Your holiday allowance is not set yet.';
                holidayRequestMessage.classList.add('error');
                return;
            }
            const requested = Number(holidayRequestDaysInput.value.trim());
            if (!Number.isFinite(requested) || requested <= 0) {
                holidayRequestMessage.textContent =
                    'Enter a valid number of holiday days.';
                holidayRequestMessage.classList.add('error');
                return;
            }
            const days = Math.floor(requested);
            if (days > me.holidayDays) {
                holidayRequestMessage.textContent =
                    'That request is bigger than your remaining holiday balance.';
                holidayRequestMessage.classList.add('error');
                return;
            }
            holidayRequestBtn.disabled = true;
            try {
                const actorLabel =
                    user.displayName?.trim() ||
                    user.email?.split('@')[0] ||
                    'Member';
                await addDoc(
                    collection(
                        db,
                        'companies',
                        companyContext.companyId,
                        HOLIDAY_REQUESTS_SUBCOLLECTION
                    ),
                    {
                        requesterUid: user.uid,
                        requesterLabel: actorLabel,
                        days,
                        status: 'pending',
                        createdAt: serverTimestamp(),
                    }
                );
                holidayRequestDaysInput.value = '';
                holidayRequestMessage.textContent =
                    'Holiday request sent to the owner.';
                holidayRequestMessage.classList.add('success');
                try {
                    await appendAuditEvent(companyContext.companyId, {
                        actorUid: user.uid,
                        actorLabel,
                        action: 'holiday_requested',
                        summary: `${actorLabel} requested ${days} holiday day${
                            days === 1 ? '' : 's'
                        }`,
                    });
                } catch {
                    /* best-effort */
                }
            } catch (err) {
                holidayRequestMessage.textContent = friendlyFirestoreError(
                    err,
                    'Could not send holiday request.'
                );
                holidayRequestMessage.classList.add('error');
            } finally {
                holidayRequestBtn.disabled = false;
            }
        });
    }

    if (companyContext?.isOwner && holidayRequestsListEl) {
        holidayRequestsListEl.addEventListener('click', async (ev) => {
            const approveBtn = (ev.target as HTMLElement).closest(
                'button[data-holiday-approve]'
            ) as HTMLButtonElement | null;
            const rejectBtn = (ev.target as HTMLElement).closest(
                'button[data-holiday-reject]'
            ) as HTMLButtonElement | null;
            if (!approveBtn && !rejectBtn) {
                return;
            }
            const reqId =
                approveBtn?.getAttribute('data-holiday-approve') ??
                rejectBtn?.getAttribute('data-holiday-reject');
            if (!reqId) {
                return;
            }
            const decision: HolidayRequestStatus = approveBtn
                ? 'approved'
                : 'rejected';
            const actorLabel =
                user.displayName?.trim() ||
                user.email?.split('@')[0] ||
                'Owner';
            const companyRef = doc(db, 'companies', companyContext.companyId);
            const reqRef = doc(
                db,
                'companies',
                companyContext.companyId,
                HOLIDAY_REQUESTS_SUBCOLLECTION,
                reqId
            );
            try {
                await runTransaction(db, async (tx) => {
                    const [reqSnap, companySnap] = await Promise.all([
                        tx.get(reqRef),
                        tx.get(companyRef),
                    ]);
                    if (!reqSnap.exists() || !companySnap.exists()) {
                        throw new Error('This request is no longer available.');
                    }
                    const req = normalizeHolidayRequest(
                        reqSnap.id,
                        reqSnap.data()
                    );
                    if (!req) {
                        throw new Error('This request is invalid.');
                    }
                    if (req.status !== 'pending') {
                        throw new Error(
                            'This request has already been processed.'
                        );
                    }
                    if (decision === 'approved') {
                        const employees = normalizeEmployeeList(
                            companySnap.data()?.employees
                        );
                        const target = employees.find(
                            (emp) => emp.uid === req.requesterUid
                        );
                        const current =
                            typeof target?.holidayDays === 'number'
                                ? target.holidayDays
                                : null;
                        if (current === null) {
                            throw new Error(
                                'That member does not have a holiday balance set.'
                            );
                        }
                        if (req.days > current) {
                            throw new Error(
                                'Request exceeds the member holiday balance.'
                            );
                        }
                        const next = employees.map((emp) =>
                            emp.uid === req.requesterUid
                                ? {
                                      ...emp,
                                      holidayDays: Math.max(
                                          0,
                                          current - req.days
                                      ),
                                  }
                                : emp
                        );
                        tx.update(companyRef, { employees: next });
                    }
                    tx.update(reqRef, {
                        status: decision,
                        resolvedAt: serverTimestamp(),
                        resolvedByUid: user.uid,
                        resolvedByLabel: actorLabel,
                    });
                });
                try {
                    await appendAuditEvent(companyContext.companyId, {
                        actorUid: user.uid,
                        actorLabel,
                        action:
                            decision === 'approved'
                                ? 'holiday_request_approved'
                                : 'holiday_request_rejected',
                        summary:
                            decision === 'approved'
                                ? 'Approved a holiday request'
                                : 'Rejected a holiday request',
                    });
                } catch {
                    /* best-effort */
                }
            } catch (err) {
                window.alert(
                    err instanceof Error
                        ? err.message
                        : friendlyFirestoreError(
                              err,
                              'Could not update holiday request.'
                          )
                );
            }
        });
    }

    const notebookRef = doc(db, USER_NOTEBOOKS_COLLECTION, user.uid);
    let notebookSaveTimer: ReturnType<typeof setTimeout> | undefined;
    if (notebookTextarea && notebookSaveStatus) {
        notebookTextarea.addEventListener('input', () => {
            notebookSaveStatus.textContent = '';
            clearTimeout(notebookSaveTimer);
            notebookSaveTimer = setTimeout(async () => {
                const text = notebookTextarea.value;
                notebookSaveStatus.textContent = 'Saving…';
                try {
                    await setDoc(
                        notebookRef,
                        {
                            content: text,
                            updatedAt: serverTimestamp(),
                        },
                        { merge: true }
                    );
                    notebookSaveStatus.textContent = 'Saved';
                } catch (err) {
                    notebookSaveStatus.textContent = friendlyFirestoreError(
                        err,
                        'Could not save notes.'
                    );
                }
            }, NOTEBOOK_AUTOSAVE_MS);
        });
    }

    if (
        companyContext &&
        dmPeerSelect &&
        dmSendForm &&
        dmBodyInput &&
        dmSendBtn &&
        dmSendMessage
    ) {
        dmPeerSelect.addEventListener('change', () => {
            dmSubscribedPeerUid = null;
            subscribeDmThread(dmPeerSelect.value);
        });

        dmSendForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            dmSendMessage.textContent = '';
            dmSendMessage.classList.remove('success', 'error');
            const peerUid = dmPeerSelect.value.trim();
            if (!peerUid) {
                dmSendMessage.textContent = 'Choose who to message.';
                dmSendMessage.classList.add('error');
                return;
            }
            const body = dmBodyInput.value.trim();
            if (!body) {
                dmSendMessage.textContent = 'Write a message first.';
                dmSendMessage.classList.add('error');
                return;
            }
            if (body.length > MEMBER_MESSAGE_BODY_MAX_LENGTH) {
                dmSendMessage.textContent = 'Message is too long.';
                dmSendMessage.classList.add('error');
                return;
            }
            const peerEmp = latestEmployees.find((emp) => emp.uid === peerUid);
            if (!peerEmp) {
                dmSendMessage.textContent =
                    'That person is not in your company directory.';
                dmSendMessage.classList.add('error');
                return;
            }
            if ((peerEmp.status ?? 'active') === 'offboarded') {
                dmSendMessage.textContent =
                    'You cannot message someone who is offboarded.';
                dmSendMessage.classList.add('error');
                return;
            }
            const fromLabel =
                user.displayName?.trim() ||
                user.email?.split('@')[0] ||
                'Member';
            const toLabel = memberDisplayName(peerEmp);
            dmSendBtn.disabled = true;
            try {
                await addDoc(
                    collection(
                        db,
                        'companies',
                        companyContext.companyId,
                        MEMBER_MESSAGES_SUBCOLLECTION
                    ),
                    {
                        fromUid: user.uid,
                        fromLabel,
                        toUid: peerUid,
                        toLabel,
                        body,
                        createdAt: serverTimestamp(),
                    }
                );
                void refreshDmThreadFromServer(peerUid);
                dmBodyInput.value = '';
                dmSendMessage.textContent = 'Sent.';
                dmSendMessage.classList.add('success');
            } catch (err) {
                dmSendMessage.textContent = friendlyFirestoreError(
                    err,
                    'Could not send. Try again.'
                );
                dmSendMessage.classList.add('error');
            } finally {
                dmSendBtn.disabled = false;
            }
        });

        fillDmRecipientOptions();
    }

    const dashboardUnsubs: Unsubscribe[] = [];

    if (companyContext) {
        const companyRef = doc(db, 'companies', companyContext.companyId);

        dashboardUnsubs.push(
            onSnapshot(companyRef, (snap) => {
                if (!snap.exists()) {
                    return;
                }
                const data = snap.data();
                latestEmployees = normalizeEmployeeList(data.employees);
                latestTeams = normalizeTeams(data.teams);
                latestInviteRoleEntries = normalizeInviteRoleEntries(
                    data.inviteRoles
                );
                if (companyContext.isOwner) {
                    refreshDashRoleList(latestInviteRoleEntries);
                }
                fillInviteRoleSelect(inviteRoleSelect, latestInviteRoleEntries);
                refreshDirectoryTable();
                refreshTeamList();
                refreshHolidayRequestAvailability();
                refreshHolidayManageGrid();
                refreshTransferOwnershipOptions();
                fillDmRecipientOptions();
            })
        );

        const auditQ = query(
            collection(db, 'companies', companyContext.companyId, 'auditLog'),
            orderBy('createdAt', 'desc'),
            limit(50)
        );
        dashboardUnsubs.push(
            onSnapshot(auditQ, (snap) => {
                refreshAuditLogFromDocs(snap.docs);
            })
        );

        const newsQ = query(
            collection(
                db,
                'companies',
                companyContext.companyId,
                COMPANY_NEWS_SUBCOLLECTION
            ),
            orderBy('createdAt', 'desc'),
            limit(50)
        );
        dashboardUnsubs.push(
            onSnapshot(newsQ, (snap) => {
                refreshCompanyNewsFromDocs(snap.docs);
            })
        );

        const meetingsQ = query(
            collection(
                db,
                'companies',
                companyContext.companyId,
                MEETINGS_SUBCOLLECTION
            ),
            orderBy('startAt', 'asc'),
            limit(MEETINGS_QUERY_LIMIT)
        );
        dashboardUnsubs.push(
            onSnapshot(meetingsQ, (snap) => {
                refreshMeetingsFromDocs(snap.docs);
            })
        );
        const invitesQ = query(
            collection(db, INVITES_COLLECTION),
            where('companyId', '==', companyContext.companyId),
            orderBy('createdAt', 'desc'),
            limit(100)
        );
        dashboardUnsubs.push(
            onSnapshot(invitesQ, (snap) => {
                latestInviteDocs = snap.docs;
                refreshInviteManageList();
            })
        );

        dashboardUnsubs.push(() => {
            dmThreadUnsubscribe?.();
            dmThreadUnsubscribe = null;
            dmSubscribedPeerUid = null;
        });

        let dmInboundNotifyReady = false;
        /** Dedupe toasts when Firestore emits both `added` and `modified` (e.g. serverTimestamp). */
        const dmNotifiedDocIds = new Set<string>();
        const DM_NOTIFY_ID_CAP = 250;
        const rememberDmNotified = (docId: string): void => {
            if (dmNotifiedDocIds.size >= DM_NOTIFY_ID_CAP) {
                const drop = Math.floor(DM_NOTIFY_ID_CAP / 2);
                let i = 0;
                for (const id of dmNotifiedDocIds) {
                    dmNotifiedDocIds.delete(id);
                    i += 1;
                    if (i >= drop) {
                        break;
                    }
                }
            }
            dmNotifiedDocIds.add(docId);
        };
        const dmInboundQ = query(
            collection(
                db,
                'companies',
                companyContext.companyId,
                MEMBER_MESSAGES_SUBCOLLECTION
            ),
            where('toUid', '==', user.uid),
            orderBy('createdAt', 'desc'),
            limit(30)
        );
        dashboardUnsubs.push(
            onSnapshot(
                dmInboundQ,
                (snap) => {
                    if (!dmInboundNotifyReady) {
                        dmInboundNotifyReady = true;
                        return;
                    }
                    for (const change of snap.docChanges()) {
                        if (change.type !== 'added' && change.type !== 'modified') {
                            continue;
                        }
                        const docSnap = change.doc;
                        if (dmNotifiedDocIds.has(docSnap.id)) {
                            continue;
                        }
                        const x = docSnap.data();
                        const fromUid =
                            typeof x.fromUid === 'string' ? x.fromUid : '';
                        if (!fromUid || fromUid === user.uid) {
                            continue;
                        }
                        const peerSelected = dmPeerSelect?.value?.trim() ?? '';
                        if (peerSelected === fromUid) {
                            void refreshDmThreadFromServer(fromUid);
                        }
                        const viewingPeer = peerSelected === fromUid;
                        if (
                            typeof document.hasFocus === 'function' &&
                            document.hasFocus() &&
                            viewingPeer
                        ) {
                            continue;
                        }
                        rememberDmNotified(docSnap.id);
                        const fromLabel =
                            typeof x.fromLabel === 'string'
                                ? x.fromLabel
                                : 'Teammate';
                        let bodyRaw =
                            typeof x.body === 'string' ? x.body.trim() : '';
                        if (bodyRaw.length > DM_NOTIFICATION_BODY_MAX) {
                            bodyRaw = `${bodyRaw.slice(0, DM_NOTIFICATION_BODY_MAX)}…`;
                        }
                        window.manageMeDesktop?.showNativeNotification?.({
                            title: fromLabel,
                            body: bodyRaw || 'New message',
                        });
                    }
                },
                (err) => {
                    console.error('DM inbound notifications listener error', err);
                }
            )
        );

        if (companyContext.isOwner && holidayRequestsListEl) {
            const holidayQ = query(
                collection(
                    db,
                    'companies',
                    companyContext.companyId,
                    HOLIDAY_REQUESTS_SUBCOLLECTION
                ),
                orderBy('createdAt', 'desc'),
                limit(50)
            );
            dashboardUnsubs.push(
                onSnapshot(holidayQ, (snap) => {
                    refreshHolidayRequestsList(snap.docs);
                })
            );
        }
    }

    dashboardUnsubs.push(
        onSnapshot(notebookRef, (snap) => {
            const content = snap.exists()
                ? String(snap.data()?.content ?? '')
                : '';
            if (!notebookTextarea) {
                return;
            }
            if (document.activeElement === notebookTextarea) {
                return;
            }
            if (notebookTextarea.value !== content) {
                notebookTextarea.value = content;
            }
        })
    );

    dashboardListenersCleanup = () => {
        dashboardUnsubs.forEach((u) => u());
    };

    const closeMenu = (): void => {
        settingsMenu.hidden = true;
        settingsBtn.setAttribute('aria-expanded', 'false');
    };

    const openMenu = (): void => {
        settingsMenu.hidden = false;
        settingsBtn.setAttribute('aria-expanded', 'true');
        syncThemePreferenceUi();
    };

    settingsBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (settingsMenu.hidden) {
            openMenu();
        } else {
            closeMenu();
        }
    });

    signOutBtn.addEventListener('click', async () => {
        closeMenu();
        await signOut(auth);
    });

    const openAiAssistantBtn = document.getElementById(
        'open-ai-assistant-btn'
    ) as HTMLButtonElement | null;
    const aiChatModalEl = document.getElementById(
        'ai-chat-modal'
    ) as HTMLDivElement | null;
    const aiChatFormEl = document.getElementById(
        'ai-chat-form'
    ) as HTMLFormElement | null;
    const aiChatInputEl = document.getElementById(
        'ai-chat-input'
    ) as HTMLTextAreaElement | null;
    const aiChatSendBtnEl = document.getElementById(
        'ai-chat-send-btn'
    ) as HTMLButtonElement | null;
    const aiChatClearBtnEl = document.getElementById(
        'ai-chat-clear-btn'
    ) as HTMLButtonElement | null;
    const aiChatStatusEl = document.getElementById(
        'ai-chat-status'
    ) as HTMLParagraphElement | null;
    const aiChatCloseBtnEl = document.getElementById(
        'ai-chat-close-btn'
    ) as HTMLButtonElement | null;

    openAiAssistantBtn?.addEventListener('click', async (e) => {
        e.stopPropagation();
        closeMenu();
        if (!aiChatModalEl) {
            return;
        }
        try {
            const snap = await getDoc(aiChatRef);
            if (snap.exists()) {
                const d = snap.data();
                aiThreadMessages = normalizeAiChatMessages(d.messages);
                const lid = d.lastResponseId;
                aiLastResponseId = typeof lid === 'string' ? lid : null;
            } else {
                aiThreadMessages = [];
                aiLastResponseId = null;
            }
        } catch {
            aiThreadMessages = [];
            aiLastResponseId = null;
        }
        renderAiChatThread();
        if (aiChatStatusEl) {
            aiChatStatusEl.textContent = '';
            aiChatStatusEl.classList.remove('error', 'success');
        }
        aiChatModalEl.hidden = false;
        aiChatInputEl?.focus();
    });

    aiChatCloseBtnEl?.addEventListener('click', () => {
        if (aiChatModalEl) {
            aiChatModalEl.hidden = true;
        }
    });

    aiChatModalEl?.addEventListener('click', (ev) => {
        if (ev.target === aiChatModalEl) {
            aiChatModalEl.hidden = true;
        }
    });

    aiChatClearBtnEl?.addEventListener('click', async () => {
        if (
            !window.confirm(
                'Clear all AI assistant messages and reset the conversation with the model?'
            )
        ) {
            return;
        }
        aiThreadMessages = [];
        aiLastResponseId = null;
        renderAiChatThread();
        if (aiChatStatusEl) {
            aiChatStatusEl.textContent = '';
            aiChatStatusEl.classList.remove('error');
        }
        try {
            await setDoc(
                aiChatRef,
                {
                    messages: [],
                    lastResponseId: null,
                    updatedAt: serverTimestamp(),
                },
                { merge: true }
            );
        } catch (err) {
            if (aiChatStatusEl) {
                aiChatStatusEl.textContent = friendlyFirestoreError(
                    err,
                    'Could not clear chat history.'
                );
                aiChatStatusEl.classList.add('error');
            }
        }
    });

    aiChatFormEl?.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (!aiChatInputEl || !aiChatStatusEl) {
            return;
        }
        const text = aiChatInputEl.value.trim();
        if (!text) {
            return;
        }
        aiChatInputEl.value = '';
        aiThreadMessages.push({ role: 'user', content: text });
        aiThreadMessages = capAiMessages(aiThreadMessages);
        renderAiChatThread();
        try {
            await persistAiChatState();
        } catch (persistErr) {
            aiChatStatusEl.textContent = friendlyFirestoreError(
                persistErr,
                'Could not save your message.'
            );
            aiChatStatusEl.classList.add('error');
            return;
        }
        aiChatStatusEl.classList.remove('error');
        aiChatStatusEl.textContent = 'Thinking…';
        if (aiChatSendBtnEl) {
            aiChatSendBtnEl.disabled = true;
        }
        try {
            const reply = await runAiAssistantTurn(text);
            aiThreadMessages.push({ role: 'assistant', content: reply });
            aiThreadMessages = capAiMessages(aiThreadMessages);
            renderAiChatThread();
            await persistAiChatState();
            aiChatStatusEl.textContent = '';
        } catch (err) {
            aiChatStatusEl.textContent =
                err instanceof Error ? err.message : 'Request failed.';
            aiChatStatusEl.classList.add('error');
        } finally {
            if (aiChatSendBtnEl) {
                aiChatSendBtnEl.disabled = false;
            }
        }
    });

    const closeInviteModal = (): void => {
        inviteModal.hidden = true;
        inviteCreateForm.reset();
        fillInviteRoleSelect(inviteRoleSelect, latestInviteRoleEntries);
        inviteResultBlock.hidden = true;
        inviteResultOutput.value = '';
        inviteExpiryNote.textContent = '';
        inviteExpiryNote.hidden = true;
        inviteModalMessage.textContent = '';
        inviteModalMessage.classList.remove('success', 'error');
    };

    const openInviteModal = (): void => {
        closeMenu();
        inviteModal.hidden = false;
        inviteResultBlock.hidden = true;
        inviteResultOutput.value = '';
        inviteExpiryNote.textContent = '';
        inviteExpiryNote.hidden = true;
        inviteModalMessage.textContent = '';
        inviteModalMessage.classList.remove('success', 'error');
        fillInviteRoleSelect(inviteRoleSelect, latestInviteRoleEntries);
        invitePersonName.focus();
    };

    const closeInviteManageModal = (): void => {
        if (!inviteManageModal || !inviteManageMessage) {
            return;
        }
        inviteManageModal.hidden = true;
        inviteManageMessage.textContent = '';
        inviteManageMessage.classList.remove('success', 'error');
        inviteManageActionBusy = false;
        refreshInviteManageList();
    };

    const openInviteManageModal = (): void => {
        if (!inviteManageModal || !inviteManageMessage) {
            return;
        }
        closeMenu();
        inviteManageModal.hidden = false;
        inviteManageMessage.textContent = '';
        inviteManageMessage.classList.remove('success', 'error');
        refreshInviteManageList();
    };

    makeInviteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (makeInviteBtn.disabled) {
            return;
        }
        openInviteModal();
    });

    manageInvitesBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (manageInvitesBtn.disabled) {
            return;
        }
        openInviteManageModal();
    });

    const closeHolidayManageModal = (): void => {
        if (!holidayManageModal || !holidayManageMessage) {
            return;
        }
        holidayManageModal.hidden = true;
        holidayManageMessage.textContent = '';
        holidayManageMessage.classList.remove('success', 'error');
    };

    const openHolidayManageModal = (): void => {
        if (!holidayManageModal || !companyContext?.isOwner) {
            return;
        }
        closeMenu();
        refreshHolidayManageGrid();
        holidayManageModal.hidden = false;
    };

    const closeTransferOwnershipModal = (): void => {
        if (!transferOwnershipModal || !transferOwnershipMessage) {
            return;
        }
        transferOwnershipModal.hidden = true;
        transferOwnershipMessage.textContent = '';
        transferOwnershipMessage.classList.remove('success', 'error');
        transferOwnershipForm?.reset();
    };

    const openTransferOwnershipModal = (): void => {
        if (!transferOwnershipModal || !companyContext?.isOwner) {
            return;
        }
        closeMenu();
        refreshTransferOwnershipOptions();
        transferOwnershipModal.hidden = false;
    };

    manageHolidaysBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        openHolidayManageModal();
    });

    transferOwnershipBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        openTransferOwnershipModal();
    });

    holidayManageCloseBtn?.addEventListener('click', () => {
        closeHolidayManageModal();
    });

    holidayManageModal?.addEventListener('click', (e) => {
        if (e.target === holidayManageModal) {
            closeHolidayManageModal();
        }
    });

    transferOwnershipClose?.addEventListener('click', () => {
        closeTransferOwnershipModal();
    });

    transferOwnershipModal?.addEventListener('click', (e) => {
        if (e.target === transferOwnershipModal) {
            closeTransferOwnershipModal();
        }
    });

    if (
        companyContext?.isOwner &&
        transferOwnershipForm &&
        transferOwnershipSelect &&
        transferOwnershipSubmit &&
        transferOwnershipMessage
    ) {
        transferOwnershipForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            transferOwnershipMessage.textContent = '';
            transferOwnershipMessage.classList.remove('success', 'error');
            const nextOwnerUid = transferOwnershipSelect.value;
            if (!nextOwnerUid) {
                transferOwnershipMessage.textContent =
                    'Choose a member to transfer ownership to.';
                transferOwnershipMessage.classList.add('error');
                return;
            }
            if (
                !window.confirm(
                    'Transfer ownership now? This change takes effect immediately.'
                )
            ) {
                return;
            }
            transferOwnershipSubmit.disabled = true;
            const companyRef = doc(db, 'companies', companyContext.companyId);
            try {
                await runTransaction(db, async (tx) => {
                    const snap = await tx.get(companyRef);
                    if (!snap.exists()) {
                        throw new Error('Company not found.');
                    }
                    const data = snap.data();
                    if (data.ownerUid !== user.uid) {
                        throw new Error(
                            'Only the current owner can transfer ownership.'
                        );
                    }
                    const employees = normalizeEmployeeList(data.employees);
                    const target = employees.find(
                        (emp) => emp.uid === nextOwnerUid
                    );
                    if (!target) {
                        throw new Error(
                            'Selected member is no longer available.'
                        );
                    }
                    if ((target.status ?? 'active') === 'offboarded') {
                        throw new Error(
                            'Cannot transfer ownership to an offboarded member.'
                        );
                    }
                    const nextEmployees = employees.map((emp) => {
                        if (emp.uid === user.uid) {
                            return { ...emp, role: 'admin', status: 'active' };
                        }
                        if (emp.uid === nextOwnerUid) {
                            return { ...emp, role: 'owner', status: 'active' };
                        }
                        return emp;
                    });
                    tx.update(companyRef, {
                        ownerUid: nextOwnerUid,
                        employees: nextEmployees,
                    });
                });
                const actorLabel =
                    user.displayName?.trim() ||
                    user.email?.split('@')[0] ||
                    'Owner';
                const targetName =
                    memberDisplayName(
                        latestEmployees.find(
                            (e2) => e2.uid === nextOwnerUid
                        ) ?? {
                            uid: nextOwnerUid,
                            role: 'member',
                            invitedForName: 'Member',
                        }
                    ) || 'Member';
                try {
                    await appendAuditEvent(companyContext.companyId, {
                        actorUid: user.uid,
                        actorLabel,
                        action: 'ownership_transferred',
                        summary: `Ownership transferred to ${targetName}`,
                    });
                } catch {
                    /* best-effort */
                }
                closeTransferOwnershipModal();
                await renderDashboard(user);
            } catch (err) {
                transferOwnershipMessage.textContent =
                    err instanceof Error
                        ? err.message
                        : friendlyFirestoreError(
                              err,
                              'Could not transfer ownership.'
                          );
                transferOwnershipMessage.classList.add('error');
            } finally {
                transferOwnershipSubmit.disabled = false;
            }
        });
    }

    if (
        companyContext?.isOwner &&
        holidayManageForm &&
        holidayManageSubmitBtn &&
        holidayManageMessage
    ) {
        holidayManageForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            holidayManageSubmitBtn.disabled = true;
            holidayManageMessage.textContent = '';
            holidayManageMessage.classList.remove('success', 'error');
            const companyRef = doc(db, 'companies', companyContext.companyId);
            const values = new Map<string, number>();
            const inputs = holidayManageForm.querySelectorAll(
                'input[data-holiday-uid]'
            );
            for (const node of inputs) {
                const input = node as HTMLInputElement;
                const uid = input.getAttribute('data-holiday-uid');
                if (!uid) {
                    continue;
                }
                const raw = input.value.trim();
                const parsed = raw === '' ? 0 : Number(raw);
                if (!Number.isFinite(parsed) || parsed < 0) {
                    holidayManageMessage.textContent =
                        'Use whole numbers 0 or above for holiday days.';
                    holidayManageMessage.classList.add('error');
                    holidayManageSubmitBtn.disabled = false;
                    return;
                }
                values.set(uid, Math.floor(parsed));
            }
            try {
                const snap = await getDoc(companyRef);
                const employees = normalizeEmployeeList(snap.data()?.employees);
                const next = employees.map((emp) => ({
                    ...emp,
                    holidayDays: values.get(emp.uid) ?? 0,
                }));
                await updateDoc(companyRef, { employees: next });
                holidayManageMessage.textContent = 'Holiday balances saved.';
                holidayManageMessage.classList.add('success');
                const actorLabel =
                    user.displayName?.trim() ||
                    user.email?.split('@')[0] ||
                    'Owner';
                try {
                    await appendAuditEvent(companyContext.companyId, {
                        actorUid: user.uid,
                        actorLabel,
                        action: 'holidays_set',
                        summary: 'Holiday balances were updated',
                    });
                } catch {
                    /* best-effort */
                }
            } catch (err) {
                holidayManageMessage.textContent = friendlyFirestoreError(
                    err,
                    'Could not save holiday balances.'
                );
                holidayManageMessage.classList.add('error');
            } finally {
                holidayManageSubmitBtn.disabled = false;
            }
        });
    }

    if (
        companyContext &&
        newRoleInput &&
        addRoleBtn &&
        roleFormMessage &&
        roleHighUpCheckbox
    ) {
        addRoleBtn.addEventListener('click', async () => {
            const name = newRoleInput.value.trim();
            roleFormMessage.classList.remove('success', 'error');
            if (!name) {
                roleFormMessage.textContent = 'Type a role name first.';
                roleFormMessage.classList.add('error');
                return;
            }

            const companyRef = doc(db, 'companies', companyContext.companyId);
            addRoleBtn.disabled = true;
            roleFormMessage.textContent = '';
            try {
                const snap = await getDoc(companyRef);
                const current = normalizeInviteRoleEntries(
                    snap.data()?.inviteRoles
                );
                if (
                    current.some(
                        (r) => r.name.toLowerCase() === name.toLowerCase()
                    )
                ) {
                    roleFormMessage.textContent =
                        'That role is already on the list.';
                    roleFormMessage.classList.add('error');
                    return;
                }
                const highUp =
                    roleNameImpliesHighUp(name) || roleHighUpCheckbox.checked;
                const next = [...current, { name, highUp }];
                await updateDoc(companyRef, { inviteRoles: next });
                latestInviteRoleEntries = next;
                newRoleInput.value = '';
                roleHighUpCheckbox.checked = false;
                refreshDashRoleList(next);
                fillInviteRoleSelect(inviteRoleSelect, latestInviteRoleEntries);
                roleFormMessage.textContent =
                    'Role added. It appears when you create an invitation.';
                roleFormMessage.classList.add('success');
                const actorLabel =
                    user.displayName?.trim() ||
                    user.email?.split('@')[0] ||
                    'User';
                try {
                    await appendAuditEvent(companyContext.companyId, {
                        actorUid: user.uid,
                        actorLabel,
                        action: 'invite_role_template_added',
                        summary: `Invitation role "${formatRoleForDisplay(name)}" was added`,
                        detail: highUp ? 'High up: yes' : 'High up: no',
                    });
                } catch {
                    /* best-effort */
                }
            } catch (err) {
                roleFormMessage.textContent = friendlyFirestoreError(
                    err,
                    'We could not save that role. Try again.'
                );
                roleFormMessage.classList.add('error');
            } finally {
                addRoleBtn.disabled = false;
            }
        });

        newRoleInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                addRoleBtn.click();
            }
        });
    }

    inviteModalClose.addEventListener('click', () => closeInviteModal());

    inviteModal.addEventListener('click', (e) => {
        if (e.target === inviteModal) {
            closeInviteModal();
        }
    });

    inviteManageClose?.addEventListener('click', () => closeInviteManageModal());

    inviteManageModal?.addEventListener('click', (e) => {
        if (e.target === inviteManageModal) {
            closeInviteManageModal();
        }
    });

    inviteManageList?.addEventListener('click', async (e) => {
        if (!companyContext || !inviteManageMessage) {
            return;
        }
        const target = e.target as HTMLElement | null;
        if (!target) {
            return;
        }
        const copyId = target.getAttribute('data-invite-copy');
        const revokeId = target.getAttribute('data-invite-revoke');
        const extendId = target.getAttribute('data-invite-extend');
        const inviteId = copyId || revokeId || extendId;
        if (!inviteId) {
            return;
        }
        inviteManageMessage.textContent = '';
        inviteManageMessage.classList.remove('success', 'error');
        if (copyId) {
            try {
                await navigator.clipboard.writeText(copyId);
                inviteManageMessage.textContent = 'Invitation ID copied.';
                inviteManageMessage.classList.add('success');
            } catch {
                inviteManageMessage.textContent =
                    'Could not copy automatically. Copy the ID manually.';
                inviteManageMessage.classList.add('error');
            }
            return;
        }
        if (inviteManageActionBusy) {
            return;
        }
        const docSnap = latestInviteDocs.find((inviteDoc) => inviteDoc.id === inviteId);
        if (!docSnap) {
            inviteManageMessage.textContent =
                'This invitation is no longer available. Refresh and try again.';
            inviteManageMessage.classList.add('error');
            return;
        }
        const statusMeta = inviteStatusMeta(docSnap);
        if (revokeId && !statusMeta.canRevoke) {
            inviteManageMessage.textContent = 'Only pending invites can be revoked.';
            inviteManageMessage.classList.add('error');
            return;
        }
        if (extendId && !statusMeta.canExtend) {
            inviteManageMessage.textContent = 'Used invitations cannot be extended.';
            inviteManageMessage.classList.add('error');
            return;
        }
        if (
            revokeId &&
            !window.confirm(
                'Revoke this invitation now? The ID will no longer be usable.'
            )
        ) {
            return;
        }
        inviteManageActionBusy = true;
        refreshInviteManageList();
        const actorLabel =
            user.displayName?.trim() || user.email?.split('@')[0] || 'User';
        const invite = docSnap.data();
        const inviteeName =
            typeof invite.inviteeName === 'string' ? invite.inviteeName.trim() : '';
        const role = typeof invite.role === 'string' ? invite.role.trim() : '';
        try {
            const inviteRef = doc(db, INVITES_COLLECTION, inviteId);
            if (revokeId) {
                await updateDoc(inviteRef, {
                    expiresAt: Timestamp.fromMillis(Date.now()),
                });
                inviteManageMessage.textContent = 'Invitation revoked.';
                inviteManageMessage.classList.add('success');
                try {
                    await appendAuditEvent(companyContext.companyId, {
                        actorUid: user.uid,
                        actorLabel,
                        action: 'invite_revoked',
                        summary: `Invitation revoked for ${inviteeName || 'a teammate'}`,
                        detail: role
                            ? `Role: ${formatRoleForDisplay(role)}`
                            : undefined,
                    });
                } catch {
                    /* best-effort */
                }
            } else if (extendId) {
                const nextExpiryMs =
                    Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
                await updateDoc(inviteRef, {
                    expiresAt: Timestamp.fromMillis(nextExpiryMs),
                });
                const nextExpiryLabel = new Date(nextExpiryMs).toLocaleDateString(
                    undefined,
                    {
                        dateStyle: 'medium',
                    }
                );
                inviteManageMessage.textContent = `Invitation extended to ${nextExpiryLabel}.`;
                inviteManageMessage.classList.add('success');
                try {
                    await appendAuditEvent(companyContext.companyId, {
                        actorUid: user.uid,
                        actorLabel,
                        action: 'invite_extended',
                        summary: `Invitation expiry extended for ${inviteeName || 'a teammate'}`,
                        detail: role
                            ? `Role: ${formatRoleForDisplay(role)}`
                            : undefined,
                    });
                } catch {
                    /* best-effort */
                }
            }
        } catch (err) {
            inviteManageMessage.textContent = friendlyFirestoreError(
                err,
                'Could not update the invitation.'
            );
            inviteManageMessage.classList.add('error');
        } finally {
            inviteManageActionBusy = false;
            refreshInviteManageList();
        }
    });

    inviteCreateForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const inviteeName = invitePersonName.value.trim();
        const role = inviteRoleSelect.value;
        if (!inviteeName || !role) {
            inviteModalMessage.textContent = 'Please fill in every field.';
            inviteModalMessage.classList.add('error');
            return;
        }

        inviteGenerateBtn.disabled = true;
        inviteModalMessage.textContent = '';
        inviteModalMessage.classList.remove('success', 'error');

        try {
            const companyId = await resolveUserCompanyId(user.uid);
            if (!companyId) {
                inviteModalMessage.textContent =
                    'No company found for your account. Create a company first.';
                inviteModalMessage.classList.add('error');
                return;
            }

            const expiryMs =
                Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
            const expiresAt = Timestamp.fromMillis(expiryMs);
            const expiryLabel = new Date(expiryMs).toLocaleDateString(
                undefined,
                {
                    dateStyle: 'medium',
                }
            );

            const docRef = await addDoc(collection(db, INVITES_COLLECTION), {
                companyId,
                role,
                inviteeName,
                createdByUid: user.uid,
                createdAt: serverTimestamp(),
                expiresAt,
                used: false,
            });

            const invActor =
                user.displayName?.trim() || user.email?.split('@')[0] || 'User';
            try {
                await appendAuditEvent(companyId, {
                    actorUid: user.uid,
                    actorLabel: invActor,
                    action: 'invite_created',
                    summary: `Invitation created for ${inviteeName}`,
                    detail: `Role: ${formatRoleForDisplay(role)}`,
                });
            } catch {
                /* best-effort */
            }

            inviteResultOutput.value = docRef.id;
            inviteResultBlock.hidden = false;
            inviteExpiryNote.textContent = `This invitation expires on ${expiryLabel} (${INVITE_EXPIRY_DAYS} days from today).`;
            inviteExpiryNote.hidden = false;
            inviteModalMessage.textContent =
                'Invitation created. Copy the ID and send it to your teammate before it expires.';
            inviteModalMessage.classList.add('success');
        } catch (error) {
            inviteModalMessage.textContent = friendlyFirestoreError(
                error,
                'We could not create that invitation. Please try again.'
            );
            inviteModalMessage.classList.add('error');
        } finally {
            inviteGenerateBtn.disabled = false;
        }
    });

    inviteCopyBtn.addEventListener('click', async () => {
        const text = inviteResultOutput.value;
        if (!text) {
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            inviteModalMessage.textContent = 'Copied to clipboard.';
            inviteModalMessage.classList.remove('error');
            inviteModalMessage.classList.add('success');
        } catch {
            inviteModalMessage.textContent =
                'Could not copy automatically. Select the text and copy manually.';
            inviteModalMessage.classList.add('error');
        }
    });

    settingsOutsideClickHandler = () => {
        if (!settingsMenu.hidden) {
            closeMenu();
        }
    };
    document.addEventListener('click', settingsOutsideClickHandler);

    settingsMenu.addEventListener('click', (e) => e.stopPropagation());
};

// =========================
// Final bootstrapping
// =========================

function escapeHtml(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

onAuthStateChanged(auth, (user) => {
    if (!user) {
        clearOnboardingSession();
        renderAuth();
        return;
    }

    if (sessionStorage.getItem(PENDING_PROFILE_KEY) === '1') {
        renderOnboarding();
        return;
    }

    void renderDashboard(user).catch((err) => console.error(err));
});
