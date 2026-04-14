/**
 * This file will automatically be loaded by webpack and run in the "renderer" context.
 * To learn more about the differences between the "main" and "renderer" context in
 * Electron, visit:
 *
 * https://electronjs.org/docs/latest/tutorial/process-model
 */

import './index.css';
import { FirebaseError } from 'firebase/app';
import type { User } from 'firebase/auth';
import {
    createUserWithEmailAndPassword,
    onAuthStateChanged,
    signInWithEmailAndPassword,
    signOut,
    updateProfile,
} from 'firebase/auth';
import { auth, db } from './firebase';
import {
    addDoc,
    collection,
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

type AuthMode = 'signin' | 'signup';

const INVITES_COLLECTION = 'invites';
const INVITE_EXPIRY_DAYS = 30;

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
        return friendlyFirestoreError(error, 'Could not join with this invitation.');
    }
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return 'Could not join with this invitation. Check the ID and try again.';
}

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
    return {
        uid,
        role,
        invitedForName,
        email,
        displayName,
        status,
        teamIds,
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

async function getUserCompanySummary(
    uid: string
): Promise<{
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
    const ownerUid =
        typeof data.ownerUid === 'string' ? data.ownerUid : '';
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
        user.displayName?.trim() ||
        user.email?.split('@')[0] ||
        'Someone';
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

const renderAuth = (): void => {
    cleanupDashboardListeners();
    detachSettingsOutsideClick();
    appRoot.innerHTML = `
    <main class="auth-page">
        <section class="auth-card">
            <h1 class="app-title">ManageMe</h1>
            <p class="auth-subtitle">Your company manager—people, roles, and structure in one place.</p>

            <div class="auth-toggle" role="tablist" aria-label="Authentication mode">
                <button id="signin-toggle" class="toggle-btn active" type="button" role="tab" aria-selected="true">
                    Sign In
                </button>
                <button id="signup-toggle" class="toggle-btn" type="button" role="tab" aria-selected="false">
                    Sign Up
                </button>
            </div>

            <form id="auth-form" class="auth-form">
                <label class="form-label" for="email-input">Email</label>
                <input id="email-input" class="form-input" type="email" autocomplete="email" placeholder="you@example.com" required />

                <label class="form-label" for="password-input">Password</label>
                <input id="password-input" class="form-input" type="password" autocomplete="current-password" placeholder="Enter your password" required />

                <button id="submit-btn" class="submit-btn" type="submit">Sign In</button>
            </form>

            <p id="auth-message" class="auth-message" aria-live="polite"></p>
        </section>
    </main>
`;

    const signInToggle = document.getElementById(
        'signin-toggle'
    ) as HTMLButtonElement;
    const signUpToggle = document.getElementById(
        'signup-toggle'
    ) as HTMLButtonElement;
    const authForm = document.getElementById('auth-form') as HTMLFormElement;
    const emailInput = document.getElementById('email-input') as HTMLInputElement;
    const passwordInput = document.getElementById(
        'password-input'
    ) as HTMLInputElement;
    const submitButton = document.getElementById(
        'submit-btn'
    ) as HTMLButtonElement;
    const authMessage = document.getElementById(
        'auth-message'
    ) as HTMLParagraphElement;

    let currentMode: AuthMode = 'signin';

    const setMode = (mode: AuthMode): void => {
        currentMode = mode;
        const isSignIn = mode === 'signin';

        signInToggle.classList.toggle('active', isSignIn);
        signUpToggle.classList.toggle('active', !isSignIn);
        signInToggle.setAttribute('aria-selected', String(isSignIn));
        signUpToggle.setAttribute('aria-selected', String(!isSignIn));

        submitButton.textContent = isSignIn ? 'Sign In' : 'Sign Up';
        passwordInput.autocomplete = isSignIn
            ? 'current-password'
            : 'new-password';
        authMessage.textContent = '';
        authMessage.classList.remove('success', 'error');
    };

    const setStatus = (message: string, type: 'success' | 'error'): void => {
        authMessage.textContent = message;
        authMessage.classList.remove('success', 'error');
        authMessage.classList.add(type);
    };

    const setLoading = (isLoading: boolean): void => {
        submitButton.disabled = isLoading;
        submitButton.textContent = isLoading
            ? currentMode === 'signin'
                ? 'Signing In...'
                : 'Signing Up...'
            : currentMode === 'signin'
              ? 'Sign In'
              : 'Sign Up';
    };

    signInToggle.addEventListener('click', () => setMode('signin'));
    signUpToggle.addEventListener('click', () => setMode('signup'));

    authForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        const email = emailInput.value.trim();
        const password = passwordInput.value.trim();

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

            <form id="profile-form" class="auth-form">
                <label class="form-label" for="display-name-input">Display name</label>
                <input id="display-name-input" class="form-input" type="text" autocomplete="name" placeholder="Your name" required maxlength="80" />

                <button id="profile-submit-btn" class="submit-btn" type="submit">Continue</button>
            </form>

            <p id="profile-message" class="auth-message" aria-live="polite"></p>
        </section>
    </main>
`;

    const profileForm = document.getElementById('profile-form') as HTMLFormElement;
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
            profileMessage.textContent = 'Session expired. Please sign in again.';
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

    const companyForm = document.getElementById('company-form') as HTMLFormElement;
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
            companyMessage.textContent = 'Session expired. Please sign in again.';
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
                    },
                ],
                employeeUids: [user.uid],
                inviteRoles: defaultInviteRoleEntries(),
            });

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
};

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
                                    <th scope="col">Teams</th>
                                    <th scope="col"><span class="sr-only">Actions</span></th>
                                </tr>
                            </thead>
                            <tbody id="directory-tbody"></tbody>
                        </table>
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
        companyContext && companyContext.isOwner ? `
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
                        <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.63.06-.940-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.07.63-.07.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
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
                ${directoryAndOpsHtml}
                ${rolesSectionHtml}
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
    </div>
`;

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

    const directorySearch = document.getElementById(
        'directory-search'
    ) as HTMLInputElement | null;
    const directoryTbody = document.getElementById(
        'directory-tbody'
    ) as HTMLTableSectionElement | null;
    const teamListEl = document.getElementById('team-list') as HTMLUListElement | null;
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

    let editingMemberUid: string | null = null;

    const refreshAuditLogFromDocs = (
        docs: QueryDocumentSnapshot[]
    ): void => {
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
                const summary =
                    typeof x.summary === 'string' ? x.summary : '';
                const actor =
                    typeof x.actorLabel === 'string'
                        ? x.actorLabel
                        : 'Someone';
                const detailRaw =
                    typeof x.detail === 'string' ? x.detail.trim() : '';
                const detail = detailRaw
                    ? `<div class="audit-log-detail">${escapeHtml(detailRaw)}</div>`
                    : '';
                return `<li class="audit-log-item"><div class="audit-log-meta"><span class="audit-log-time">${escapeHtml(when)}</span><span class="audit-log-actor">${escapeHtml(actor)}</span></div><div class="audit-log-summary">${escapeHtml(summary)}</div>${detail}</li>`;
            })
            .join('');
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
                    .map((id) =>
                        teamNameById(latestTeams, id).toLowerCase()
                    )
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
                const actionsCell = canEdit
                    ? `<button type="button" class="submit-btn submit-btn--table" data-member-edit="${escapeHtml(e.uid)}">Edit</button>`
                    : '—';
                return `<tr><td>${name}</td><td>${email}</td><td>${role}</td><td><span class="${stClass}">${stLabel}</span></td><td>${teamsCell}</td><td>${actionsCell}</td></tr>`;
            })
            .join('');
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
                const id = crypto.randomUUID();
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
                user.displayName?.trim() ||
                user.email?.split('@')[0] ||
                'User';

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
                if (
                    !teamIdsEqual(before.teamIds ?? [], newTeamIds)
                ) {
                    const fmt = (ids: string[]) =>
                        ids.length === 0
                            ? 'None'
                            : ids.map((id) => teamNameById(latestTeams, id))
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

    if (companyContext) {
        const companyRef = doc(db, 'companies', companyContext.companyId);
        const unsubs: Unsubscribe[] = [];

        unsubs.push(
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
                fillInviteRoleSelect(
                    inviteRoleSelect,
                    latestInviteRoleEntries
                );
                refreshDirectoryTable();
                refreshTeamList();
            })
        );

        const auditQ = query(
            collection(db, 'companies', companyContext.companyId, 'auditLog'),
            orderBy('createdAt', 'desc'),
            limit(50)
        );
        unsubs.push(
            onSnapshot(auditQ, (snap) => {
                refreshAuditLogFromDocs(snap.docs);
            })
        );

        dashboardListenersCleanup = () => {
            unsubs.forEach((u) => u());
        };
    }

    const closeMenu = (): void => {
        settingsMenu.hidden = true;
        settingsBtn.setAttribute('aria-expanded', 'false');
    };

    const openMenu = (): void => {
        settingsMenu.hidden = false;
        settingsBtn.setAttribute('aria-expanded', 'true');
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

    makeInviteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (makeInviteBtn.disabled) {
            return;
        }
        openInviteModal();
    });

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
            const expiryLabel = new Date(expiryMs).toLocaleDateString(undefined, {
                dateStyle: 'medium',
            });

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
                user.displayName?.trim() ||
                user.email?.split('@')[0] ||
                'User';
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
