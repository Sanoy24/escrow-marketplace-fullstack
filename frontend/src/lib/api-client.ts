/**
 * Phase 10 (frontend migration — see docs/ARCHITECTURE.md's BFF-removal
 * section). Replaces the old Next frontend's `backend-api.ts` BFF proxy:
 * this calls the backend directly from the browser, with `credentials:
 * 'include'` so the httpOnly refresh-token cookie rides along
 * automatically. The access token is NEVER persisted (no localStorage,
 * no cookie of its own) — it lives only in the module-level variable
 * below, set by `setAccessToken` (called from auth-context.tsx on
 * login/refresh/logout) and read by every authenticated request this
 * module makes. A page reload always starts from zero and re-derives a
 * fresh one via `refreshTokens()`, which works because the browser still
 * has the refresh cookie.
 */

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL ?? 'http://localhost:3000';

// Matches the exact contract in backend/src/auth/auth.controller.ts's
// PublicUser — ported verbatim from the old frontend's backend-api.ts.
export interface PublicUser {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  verificationLevel: 'none' | 'phone' | 'id' | 'business';
  payoutBankCode: string | null;
  payoutAccountNumber: string | null;
  payoutAccountName: string | null;
  createdAt: string;
}

export class BackendApiError extends Error {
  // Not a constructor parameter property — this tsconfig's
  // `erasableSyntaxOnly` disallows that shorthand (it emits real runtime
  // assignment code, which isn't erasable TS-to-JS syntax).
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'BackendApiError';
    this.status = status;
  }
}

interface BackendErrorBody {
  statusCode: number;
  message: string | string[];
  error: string;
}

function isErrorBody(body: unknown): body is BackendErrorBody {
  return typeof body === 'object' && body !== null && 'message' in body;
}

function extractErrorMessage(body: unknown, fallback: string): string {
  if (!isErrorBody(body)) return fallback;
  const { message } = body;
  if (Array.isArray(message)) return message.join(', ');
  return typeof message === 'string' ? message : fallback;
}

async function parseJson(res: Response): Promise<unknown> {
  return res.json().catch(() => null) as Promise<unknown>;
}

// --- In-memory access token — see this file's own top comment for why
// this is a plain module variable, not React state or any persisted
// storage. ---

let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/**
 * Calls the real refresh endpoint via the httpOnly cookie (no body
 * needed — see backend/src/auth/auth.controller.ts's cookie fallback,
 * Phase 10 PR 0). Returns the new access token on success, or null if
 * the refresh token is missing/expired/revoked — the caller decides
 * what "no session" means (redirect to /login, show logged-out UI,
 * etc.), this function never redirects itself.
 */
async function refreshTokens(): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_URL}/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch {
    // The backend being genuinely unreachable (not just a 401/no-cookie
    // response) must resolve to "no session" too, not throw — this runs
    // unconditionally on every app boot (see auth-context.tsx), so an
    // uncaught rejection here would strand the app on a permanent
    // loading state instead of falling back to a logged-out view.
    setAccessToken(null);
    return null;
  }
  if (!res.ok) {
    setAccessToken(null);
    return null;
  }
  const body = (await parseJson(res)) as TokenPair | null;
  if (!body?.accessToken) {
    setAccessToken(null);
    return null;
  }
  setAccessToken(body.accessToken);
  return body.accessToken;
}

// Dedupes concurrent refreshes — several callers hitting this at once
// (several components' 401s right after the access token expires, or
// React StrictMode's dev-only double-invoke of AuthProvider's boot
// effect) must not each independently race the backend's refresh-token
// rotation; only the first caller actually refreshes, everyone else
// awaits that same promise. See backend/src/auth/auth.service.ts#refresh's
// own reuse-detection, which a parallel second real refresh call would
// otherwise trip — confirmed by hand: without this, the dev-only
// StrictMode double-invoke alone was enough to trigger a 409 and get the
// whole refresh-token family revoked, silently logging out every reload.
// This is the ONLY path to a refresh anywhere in this module —
// `refreshTokens` itself is not exported.
let inFlightRefresh: Promise<string | null> | null = null;

export function refreshOnce(): Promise<string | null> {
  if (!inFlightRefresh) {
    inFlightRefresh = refreshTokens().finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

export interface BackendFetchInit extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Skip the Authorization header and the 401-triggered refresh retry
   * — for endpoints callable while logged out (signup, login, etc.). */
  anonymous?: boolean;
}

/**
 * The one place every API call in this app goes through. On a 401 from
 * an authenticated call, tries exactly one silent refresh and retries
 * the original request once with the new token — if that still fails,
 * the error propagates and the caller (ultimately the route guard/auth
 * context) is responsible for treating it as "session is really gone."
 */
export async function backendFetch(path: string, init: BackendFetchInit = {}): Promise<Response> {
  const { anonymous, body, headers, ...rest } = init;

  const doFetch = (): Promise<Response> =>
    fetch(`${BACKEND_URL}${path}`, {
      ...rest,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(!anonymous && accessToken && { Authorization: `Bearer ${accessToken}` }),
        ...headers,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });

  const res = await doFetch();
  if (res.status !== 401 || anonymous || !accessToken) {
    return res;
  }

  const refreshed = await refreshOnce();
  if (!refreshed) {
    return res;
  }
  return doFetch();
}

/** Thin wrapper most call sites use: parses the body, throws
 * BackendApiError on a non-2xx, returns the typed body otherwise. */
export async function backendJson<T>(
  path: string,
  init: BackendFetchInit = {},
  fallbackErrorMessage = 'Request failed.',
): Promise<T> {
  const res = await backendFetch(path, init);
  const body = await parseJson(res);
  if (!res.ok) {
    throw new BackendApiError(res.status, extractErrorMessage(body, fallbackErrorMessage));
  }
  return body as T;
}

// --- Auth endpoints — matches the exact contract in
// backend/src/auth/auth.controller.ts (ported from the old frontend's
// backend-api.ts, same endpoints/payloads, called directly from the
// browser now instead of proxied through a Next server). Every call here
// is `anonymous: true` since none require a prior session, and none
// should trigger backendFetch's 401-retry-refresh logic. ---

export interface MessageResult {
  message: string;
}

export interface AuthResult extends TokenPair {
  user: PublicUser;
}

export async function signup(
  phone: string,
  password: string,
  name?: string,
  email?: string,
): Promise<MessageResult> {
  return backendJson<MessageResult>(
    '/auth/signup',
    { method: 'POST', body: { phone, password, name, email }, anonymous: true },
    'Failed to create account.',
  );
}

export async function verifySignup(phone: string, code: string): Promise<AuthResult> {
  return backendJson<AuthResult>(
    '/auth/signup/verify',
    { method: 'POST', body: { phone, code }, anonymous: true },
    'Invalid or expired code.',
  );
}

export async function login(phone: string, password: string): Promise<AuthResult> {
  return backendJson<AuthResult>(
    '/auth/login',
    { method: 'POST', body: { phone, password }, anonymous: true },
    'Invalid phone number or password.',
  );
}

export async function forgotPassword(phone: string): Promise<MessageResult> {
  return backendJson<MessageResult>(
    '/auth/forgot-password',
    { method: 'POST', body: { phone }, anonymous: true },
    'Failed to send reset code.',
  );
}

/** Deliberately returns only tokens, no user — see
 * backend/src/auth/auth.controller.ts. Callers fetch `/auth/me`
 * separately (via `getMe`) once the token is set. */
export async function resetPassword(
  phone: string,
  code: string,
  newPassword: string,
): Promise<TokenPair> {
  return backendJson<TokenPair>(
    '/auth/reset-password',
    { method: 'POST', body: { phone, code, newPassword }, anonymous: true },
    'Invalid or expired code.',
  );
}

export async function exchangeSocialCode(code: string): Promise<AuthResult> {
  return backendJson<AuthResult>(
    '/auth/social/exchange',
    { method: 'POST', body: { code }, anonymous: true },
    'Invalid or expired code.',
  );
}

export async function completeSocialSignup(
  pendingToken: string,
  phone: string,
): Promise<MessageResult> {
  return backendJson<MessageResult>(
    '/auth/social/complete',
    { method: 'POST', body: { pendingToken, phone }, anonymous: true },
    'This sign-up link has expired.',
  );
}

export async function getMe(): Promise<PublicUser> {
  return backendJson<PublicUser>('/auth/me');
}

// --- Categories & listings — matches backend/src/categories,
// backend/src/listings. Ported from the old frontend's backend-api.ts. ---

export interface Category {
  id: string;
  name: string;
  slug: string;
  parentId: string | null;
  description: string | null;
  imageUrl: string | null;
  createdAt: string;
}

export interface Listing {
  id: string;
  sellerId: string;
  categoryId: string;
  storeId: string | null;
  branchId: string | null;
  title: string;
  description: string | null;
  priceSantim: string;
  weightKg: number | null;
  condition: 'new' | 'used';
  status: 'pending_review' | 'active' | 'sold' | 'expired' | 'removed';
  flaggedReason: string | null;
  locationCity: string;
  locationArea: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface ListingImage {
  id: string;
  listingId: string;
  url: string;
  sortOrder: number;
  createdAt: string;
}

export type ListingWithPrimaryImage = Listing & { primaryImageUrl: string | null };

export interface PaginatedListings {
  items: ListingWithPrimaryImage[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ListingFilters {
  category_id?: string;
  min_price?: string;
  max_price?: string;
  location?: string;
  condition?: string;
  sort?: string;
  q?: string;
  seller_id?: string;
  exclude_id?: string;
  page?: number;
  page_size?: number;
}

export type ListingDetail = Listing & {
  images: ListingImage[];
  seller: {
    name: string | null;
    memberSince: string;
    activeListingCount: number;
    soldListingCount: number;
    ratingAvg: number | null;
    ratingCount: number;
  };
  storeSlug: string | null;
  viewCount: number;
  likeCount: number;
};

export async function listCategories(): Promise<Category[]> {
  return backendJson<Category[]>('/categories', { anonymous: true }, 'Failed to load categories.');
}

// Query params are snake_case to match the documented API contract exactly
// (backend/src/listings/dto/query-listings.dto.ts) — not a typo.
export async function listListings(filters: ListingFilters): Promise<PaginatedListings> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return backendJson<PaginatedListings>(
    `/listings${query ? `?${query}` : ''}`,
    { anonymous: true },
    'Failed to load listings.',
  );
}

// Deliberately NOT `anonymous: true` — unlike listCategories/listListings/
// getStore (genuinely public, never took a token even in the old
// frontend), a signed-in viewer's own non-active (pending_review/sold/
// removed/expired) listing is only visible when the request carries their
// token, matching the old frontend's optional-accessToken parameter. An
// anonymous visitor still gets the normal public (active-only) response
// — backendFetch simply omits the Authorization header when there's no
// token in memory.
export async function getListing(id: string): Promise<ListingDetail> {
  return backendJson<ListingDetail>(`/listings/${id}`, {}, 'Listing not found.');
}

/** Requires auth — unlike getListing, this always needs a real signed-in viewer. */
export async function getListingContact(id: string): Promise<{ phone: string }> {
  return backendJson<{ phone: string }>(`/listings/${id}/contact`, {}, 'Failed to load contact.');
}

// --- Favorites — matches backend/src/favorites ---

export interface FavoriteSummary {
  id: string;
  createdAt: string;
  listing: ListingWithPrimaryImage;
}

export async function listFavorites(): Promise<FavoriteSummary[]> {
  return backendJson<FavoriteSummary[]>('/favorites', {}, 'Failed to load favorites.');
}

export async function addFavorite(listingId: string): Promise<void> {
  await backendJson(
    '/favorites',
    { method: 'POST', body: { listingId } },
    'Failed to save listing.',
  );
}

export async function removeFavorite(listingId: string): Promise<void> {
  await backendJson(`/favorites/${listingId}`, { method: 'DELETE' }, 'Failed to remove favorite.');
}

// --- Messaging — matches backend/src/messaging ---

export interface Conversation {
  id: string;
  listingId: string;
  buyerId: string;
  sellerId: string;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  createdAt: string;
  listing: { id: string; title: string; primaryImageUrl: string | null };
  otherParticipant: { id: string; name: string | null; phone: string };
  lastMessage: { body: string; sentAt: string } | null;
}

export interface Message {
  id: string;
  conversationId: string;
  senderId: string;
  body: string;
  sentAt: string;
  readAt: string | null;
}

export interface PaginatedMessages {
  items: Message[];
  page: number;
  pageSize: number;
  total: number;
}

export async function createConversation(listingId: string): Promise<Conversation> {
  return backendJson<Conversation>(
    '/conversations',
    { method: 'POST', body: { listingId } },
    'Failed to start conversation.',
  );
}

export async function listConversations(): Promise<ConversationSummary[]> {
  return backendJson<ConversationSummary[]>(
    '/conversations',
    {},
    'Failed to load conversations.',
  );
}

export async function getMessages(
  conversationId: string,
  page?: number,
): Promise<PaginatedMessages> {
  const query = page ? `?page=${page}` : '';
  return backendJson<PaginatedMessages>(
    `/conversations/${conversationId}/messages${query}`,
    {},
    'Failed to load messages.',
  );
}

// --- Orders & escrow (just enough for "pay via escrow" here — the full
// orders surface is PR 6's job) — matches backend/src/orders, backend/src/escrow ---

export type OrderDeliveryMethod = 'platform_delivery' | 'self_pickup' | 'seller_arranged';

export interface OrderItem {
  id: string;
  orderId: string;
  listingId: string;
  priceAtPurchaseSantim: string;
}

export type EscrowStatus = 'pending_payment' | 'held' | 'released' | 'disputed' | 'refunded';

export interface EscrowTransaction {
  id: string;
  orderId: string;
  buyerId: string;
  sellerId: string;
  amountSantim: string;
  platformFeeSantim: string | null;
  chapaTxRef: string;
  chapaTransferRef: string | null;
  status: EscrowStatus;
  heldAt: string | null;
  autoReleaseAt: string | null;
  releasedAt: string | null;
  createdAt: string;
}

export type DeliveryStatus = 'pending_assignment' | 'assigned' | 'picked_up' | 'delivered';

export interface Delivery {
  id: string;
  orderId: string;
  storeId: string;
  branchId: string;
  status: DeliveryStatus;
  assignedDriverId: string | null;
  assignedByDispatcherId: string | null;
  assignedAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  createdAt: string;
}

export interface OrderDetail {
  id: string;
  buyerId: string;
  sellerId: string;
  storeId: string | null;
  deliveryMethod: OrderDeliveryMethod;
  subtotalSantim: string;
  deliveryFeeSantim: string;
  totalSantim: string;
  createdAt: string;
  items: OrderItem[];
  escrowTransaction: EscrowTransaction | null;
  deliveries: Delivery[];
  hasReviewed?: boolean;
}

export async function createOrder(
  listingIds: string[],
  // Only meaningful for a >1-listing (store) order — ignored by the
  // backend for a single-listing order, which is always seller_arranged.
  deliveryMethod?: Extract<OrderDeliveryMethod, 'platform_delivery' | 'self_pickup'>,
): Promise<OrderDetail> {
  return backendJson<OrderDetail>(
    '/orders',
    { method: 'POST', body: { listingIds, deliveryMethod } },
    'Failed to create order.',
  );
}

export async function initiateEscrow(
  orderId: string,
): Promise<{ escrowTransaction: EscrowTransaction; checkoutUrl: string }> {
  return backendJson<{ escrowTransaction: EscrowTransaction; checkoutUrl: string }>(
    '/escrow',
    { method: 'POST', body: { orderId } },
    'Failed to start escrow payment.',
  );
}

export async function getOrder(id: string): Promise<OrderDetail> {
  return backendJson<OrderDetail>(`/orders/${id}`, {}, 'Failed to load order.');
}

export type OrderSummary = OrderDetail;

export async function listMyOrders(): Promise<OrderSummary[]> {
  return backendJson<OrderSummary[]>('/orders/mine', {}, 'Failed to load orders.');
}

export async function confirmEscrowReceipt(escrowTransactionId: string): Promise<EscrowTransaction> {
  return backendJson<EscrowTransaction>(
    `/escrow/${escrowTransactionId}/confirm-receipt`,
    { method: 'POST' },
    'Failed to confirm receipt.',
  );
}

export async function raiseEscrowDispute(
  escrowTransactionId: string,
  reason: string,
): Promise<EscrowTransaction> {
  return backendJson<EscrowTransaction>(
    `/escrow/${escrowTransactionId}/dispute`,
    { method: 'POST', body: { reason } },
    'Failed to raise a dispute.',
  );
}

export interface Review {
  id: string;
  escrowTransactionId: string;
  reviewerId: string;
  revieweeId: string;
  rating: number;
  comment: string | null;
  createdAt: string;
}

export async function submitReview(
  escrowTransactionId: string,
  rating: number,
  comment: string | undefined,
): Promise<Review> {
  return backendJson<Review>(
    `/escrow/${escrowTransactionId}/review`,
    { method: 'POST', body: { rating, comment } },
    'Failed to submit review.',
  );
}

// --- Barter — matches backend/src/barter ---

export interface ExchangeOffer {
  id: string;
  proposalId: string;
  offeredBy: string;
  offeredListingId: string;
  requestedListingId: string;
  cashDifferenceSantim: string | null;
  createdAt: string;
}

export interface ExchangeListingSummary {
  id: string;
  title: string;
  priceSantim: string;
  status: string;
  primaryImageUrl: string | null;
}

export interface ExchangeProposalSummary {
  id: string;
  status: 'open' | 'accepted' | 'rejected' | 'cancelled';
  createdAt: string;
  proposerId: string;
  ownerId: string;
  latestOffer: ExchangeOffer;
  listingsById: Record<string, ExchangeListingSummary>;
}

export interface ExchangeProposalDetail extends ExchangeProposalSummary {
  offers: ExchangeOffer[];
}

export async function listExchangeProposals(): Promise<ExchangeProposalSummary[]> {
  return backendJson<ExchangeProposalSummary[]>(
    '/exchange-proposals',
    {},
    'Failed to load trades.',
  );
}

export async function getExchangeProposal(id: string): Promise<ExchangeProposalDetail> {
  return backendJson<ExchangeProposalDetail>(
    `/exchange-proposals/${id}`,
    {},
    'Failed to load trade.',
  );
}

export async function createExchangeProposal(dto: {
  initiatingListingId: string;
  targetListingId: string;
}): Promise<ExchangeProposalSummary> {
  return backendJson<ExchangeProposalSummary>(
    '/exchange-proposals',
    { method: 'POST', body: dto },
    'Failed to propose trade.',
  );
}

export async function addExchangeOffer(
  proposalId: string,
  dto: { offeredListingId: string; requestedListingId: string },
): Promise<ExchangeOffer> {
  return backendJson<ExchangeOffer>(
    `/exchange-proposals/${proposalId}/offers`,
    { method: 'POST', body: dto },
    'Failed to send counter-offer.',
  );
}

async function postExchangeProposalAction(
  proposalId: string,
  action: 'accept' | 'reject' | 'cancel',
): Promise<ExchangeProposalSummary> {
  return backendJson<ExchangeProposalSummary>(
    `/exchange-proposals/${proposalId}/${action}`,
    { method: 'POST' },
    `Failed to ${action} trade.`,
  );
}

export function acceptExchangeProposal(proposalId: string): Promise<ExchangeProposalSummary> {
  return postExchangeProposalAction(proposalId, 'accept');
}

export function rejectExchangeProposal(proposalId: string): Promise<ExchangeProposalSummary> {
  return postExchangeProposalAction(proposalId, 'reject');
}

export function cancelExchangeProposal(proposalId: string): Promise<ExchangeProposalSummary> {
  return postExchangeProposalAction(proposalId, 'cancel');
}

// --- Stores (just enough for the storefront + checkout page here — the
// full stores surface, branch/staff management, is PR 7's job) — matches
// backend/src/stores ---

export interface Store {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  description: string | null;
  logoUrl: string | null;
  bannerUrl: string | null;
  defaultDeliveryFeeSantim: string;
  weightThresholdKg: number | null;
  extraWeightFeeSantim: string | null;
  createdAt: string;
}

export async function getStore(
  slug: string,
): Promise<{ store: Store; listings: ListingWithPrimaryImage[] }> {
  return backendJson<{ store: Store; listings: ListingWithPrimaryImage[] }>(
    `/stores/${slug}`,
    { anonymous: true },
    'Failed to load store.',
  );
}

// --- Listing reports — matches backend/src/listing-reports ---

export type ListingReportReason = 'prohibited_item' | 'scam_or_fraud' | 'misleading' | 'other';

export interface ListingReport {
  id: string;
  listingId: string;
  reporterId: string;
  reason: ListingReportReason;
  detail: string | null;
  status: 'pending' | 'dismissed' | 'actioned';
  resolvedByAdminId: string | null;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export async function reportListing(
  listingId: string,
  reason: ListingReportReason,
  detail: string | undefined,
): Promise<ListingReport> {
  return backendJson<ListingReport>(
    `/listings/${listingId}/report`,
    { method: 'POST', body: { reason, detail } },
    'Failed to report this listing.',
  );
}

// --- Listing creation & management — matches backend/src/listings ---

// activeBoostEndsAt is only ever populated on GET /listings/mine — null
// everywhere else (never a real boost, just "not the seller's own view").
export type MyListing = ListingWithPrimaryImage & { activeBoostEndsAt: string | null };

/** Auth-required — the caller's own listings, across every status. */
export async function listMyListings(status?: Listing['status']): Promise<MyListing[]> {
  const query = status ? `?status=${status}` : '';
  return backendJson<MyListing[]>(`/listings/mine${query}`, {}, 'Failed to load your listings.');
}

export interface CreateListingInput {
  categoryId: string;
  title: string;
  description?: string;
  price: string;
  // Optional — only feeds the opt-in weight-based delivery surcharge. See
  // docs/ARCHITECTURE.md §9.
  weightKg?: string;
  // Only meaningful for a seller with a multi-branch store — required only
  // then (a single-branch store auto-resolves). See docs/ARCHITECTURE.md
  // §10.
  branchId?: string;
  condition: 'new' | 'used';
  locationCity: string;
  locationArea?: string;
}

export async function createListing(dto: CreateListingInput): Promise<Listing> {
  return backendJson<Listing>(
    '/listings',
    { method: 'POST', body: dto },
    'Failed to create listing.',
  );
}

/**
 * Bypasses backendJson/backendFetch: a multipart body must not carry a
 * `Content-Type: application/json` header, and fetch needs to generate
 * its own boundary. Still goes through the same 401-retry-once logic as
 * every other authenticated call, just hand-rolled for this one case.
 */
export async function uploadListingImages(
  listingId: string,
  files: File[],
): Promise<ListingImage[]> {
  const formData = new FormData();
  for (const file of files) {
    formData.append('images', file);
  }

  const doUpload = () =>
    fetch(`${BACKEND_URL}/listings/${listingId}/images`, {
      method: 'POST',
      credentials: 'include',
      headers: getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {},
      body: formData,
    });

  let res = await doUpload();
  if (res.status === 401) {
    const refreshed = await refreshOnce();
    if (refreshed) res = await doUpload();
  }
  const body = await parseJson(res);
  if (!res.ok) {
    throw new BackendApiError(res.status, extractErrorMessage(body, 'Failed to upload images.'));
  }
  return body as ListingImage[];
}

// --- Store branches (just enough to power the create-listing branch
// picker here — full branch management is PR 7's job) — matches
// backend/src/stores ---

export interface StoreBranch {
  id: string;
  storeId: string;
  name: string;
  city: string | null;
  area: string | null;
  isDefault: boolean;
  phone: string | null;
  weightThresholdKg: number | null;
  extraWeightFeeSantim: string | null;
  createdAt: string;
}

/** The caller's own store, or null if they haven't opened one yet. */
export async function getMyStore(): Promise<Store | null> {
  return backendJson<Store | null>('/stores/mine', {}, 'Failed to load your store.');
}

/** Every store always has >=1 branch — see docs/ARCHITECTURE.md §10. */
export async function listStoreBranches(storeId: string): Promise<StoreBranch[]> {
  return backendJson<StoreBranch[]>(
    `/stores/${storeId}/branches`,
    {},
    'Failed to load branches.',
  );
}

// --- Boosts — matches backend/src/boosts ---

export type BoostTier = '3_day' | '7_day' | '14_day';

export interface Boost {
  id: string;
  listingId: string;
  tier: BoostTier;
  priceSantim: string;
  status: 'pending_payment' | 'active';
  chapaTxRef: string;
  startsAt: string | null;
  endsAt: string | null;
  createdAt: string;
}

// Not gated on business verification — any seller with an active listing
// can boost it.
export async function createBoost(
  listingId: string,
  tier: BoostTier,
): Promise<{ boost: Boost; checkoutUrl: string }> {
  return backendJson<{ boost: Boost; checkoutUrl: string }>(
    '/boosts',
    { method: 'POST', body: { listingId, tier } },
    'Failed to start boost payment.',
  );
}
