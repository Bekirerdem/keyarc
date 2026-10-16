// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Rules} from "./CollectiveTypes.sol";

/// @title Collective
/// @notice A team's payment link. Every person on an invoice agrees to the shares before the client can pay;
///         when the money lands, everyone is paid on the spot. If the team chose to, a share is first set aside
///         for shared costs. Nobody (creator, agent or any single member) can move funds or change rules alone.
contract Collective is Initializable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_MEMBERS = 50;
    uint256 public constant MAX_CONTRIBUTORS = 20;
    uint256 public constant MAX_NOTE = 280;
    uint16 internal constant BPS = 10_000;
    uint32 public constant MIN_TIMELOCK = 1 hours;
    uint32 public constant MAX_TIMELOCK = 30 days;
    uint32 public constant MIN_PERIOD = 1 hours;
    uint32 public constant MAX_PERIOD = 366 days;
    uint64 public constant PROPOSAL_TTL = 7 days;

    /// @dev What a contributor signs to agree to an invoice. Arrays are hashed per EIP-712 (32 bytes per element).
    bytes32 public constant APPROVE_TYPEHASH = keccak256(
        "ApproveInvoice(bytes32 id,uint256 amount,address payer,uint64 dueAt,uint16 reserveBps,address[] contributors,uint16[] sharesBps)"
    );

    enum InvoiceStatus { None, Open, Paid, Cancelled }
    enum Kind { SetRules, AddMember, RemoveMember, SetAgent, SetPayee, ReleaseReserve, Attribute, Expense, SettleInvoice }

    struct Invoice {
        uint256 amount;
        address creator;
        address payer;
        InvoiceStatus status;
        uint64 dueAt;
        uint16 reserveBps; // the shared-costs share when it was written: what everyone agreed to
        uint8 pending; // contributors who haven't agreed to their share yet
        address[] contributors;
        uint16[] sharesBps;
    }

    struct Proposal {
        Kind kind;
        bytes payload;
        bytes32 ref;
        address proposer;
        uint64 executableAt;
        uint64 expiresAt;
        uint64 epoch;
        uint32 votes;
        uint32 votesNeeded;
        bool executed;
        bool cancelled;
    }

    IERC20 public usdc;
    string public name;
    address public agent;
    Rules internal _rules;
    address[] internal _members;
    mapping(address => bool) public isMember;
    mapping(address => bool) public isPayee;

    /// @notice Set aside for shared costs. Leaves only to allowlisted bills (agent, within its limit) or by vote.
    uint256 public reserve;
    uint256 public totalOwed;
    mapping(address => uint256) public owed;

    /// @notice The agent's limits apply per window of `periodLength`; a new window starts on its first action after the last ended.
    uint256 public period;
    uint64 public periodStart;
    uint256 public expensesThisPeriod;
    uint256 public attributedThisPeriod;
    uint64 public governanceEpoch;

    mapping(bytes32 => Invoice) internal _invoices;
    /// @notice Whether a contributor agreed to their share on an invoice. The creator agrees by creating it.
    mapping(bytes32 => mapping(address => bool)) public approved;
    Proposal[] internal _proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    /// @notice References (an inflow's tx hash, a sealed decision) already used by the agent; makes retries idempotent.
    mapping(bytes32 => bool) public usedRef;
    /// @notice Where a member's share is sent; zero means the member's own address.
    mapping(address => address) public payoutTo;

    event CollectiveInitialized(string name, address[] members, address agent);
    event InvoiceCreated(
        bytes32 indexed id,
        address indexed creator,
        uint256 amount,
        address payer,
        uint64 dueAt,
        address[] contributors,
        uint16[] sharesBps,
        string note
    );
    event InvoiceApproved(bytes32 indexed id, address indexed member);
    event InvoicePaid(bytes32 indexed id, address indexed payer, uint256 amount, uint256 toReserve);
    /// @notice An invoice paid from money that arrived without a reference (e.g. a CCTP mint from another chain).
    event InvoiceSettled(bytes32 indexed id, bytes32 ref, uint256 amount);
    event InvoiceCancelled(bytes32 indexed id);
    event Attributed(address indexed member, uint256 amount, bytes32 ref);
    event ExpensePaid(address indexed to, uint256 amount, bytes32 ref);
    /// @param source the invoice id, the attribution ref, or zero for a reserve release
    event Paid(bytes32 indexed source, address indexed member, address to, uint256 amount);
    event PayoutDeferred(bytes32 indexed source, address indexed member, uint256 amount);
    event Claimed(address indexed member, address to, uint256 amount);
    event PayoutAddressSet(address indexed member, address to);
    event Proposed(
        uint256 indexed id, Kind kind, address indexed proposer, bytes32 ref, bytes payload, uint64 executableAt, uint32 votesNeeded
    );
    event Voted(uint256 indexed id, address indexed member);
    event Unvoted(uint256 indexed id, address indexed member);
    event Cancelled(uint256 indexed id);
    event ReserveReleased(address indexed to, uint256 amount);
    event Executed(uint256 indexed id, Kind kind);

    error NotAMember(address account);
    error NotMemberOrAgent();
    error NotAgent();
    error BadRules();
    error BadMembers();
    error BadShares();
    error NoteTooLong();
    error BadPayout();
    error InvoiceExists();
    error AmountMismatch();
    error AwaitingApproval();
    error AlreadyApproved();
    error NotAContributor();
    error BadSignature();
    error ProposalExpired();
    error ProposalStale();
    error ProposalCancelled();
    error NotProposer();
    error NotVoted();
    error NotInvoiceOwner();
    error RefAlreadyUsed();
    error RefRequired();
    error InvoiceNotOpen();
    error WrongPayer();
    error ZeroAmount();
    error ExceedsUnattributed();
    error AboveCap();
    error NotPayee(address to);
    error InsufficientReserve();
    error AgentCannotPropose(Kind kind);
    error AlreadyVoted();
    error AlreadyExecuted();
    error NoQuorum();
    error TimelockActive();
    error UnknownProposal();

    modifier onlyMember() {
        if (!isMember[msg.sender]) revert NotAMember(msg.sender);
        _;
    }

    modifier onlyMemberOrAgent() {
        if (!isMember[msg.sender] && (msg.sender != agent || agent == address(0))) revert NotMemberOrAgent();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent || agent == address(0)) revert NotAgent();
        _;
    }

    /// @dev Clones share the implementation's name and version; the domain separator is rebuilt for each clone's address.
    constructor() EIP712("Keyarc", "4") {
        _disableInitializers();
    }

    function initialize(
        IERC20 usdc_,
        string calldata name_,
        address[] calldata members_,
        Rules calldata rules_,
        address agent_
    ) external initializer {
        if (members_.length == 0 || members_.length > MAX_MEMBERS) revert BadMembers();
        _validateRules(rules_);
        usdc = usdc_;
        name = name_;
        agent = agent_;
        _rules = rules_;
        for (uint256 i; i < members_.length; ++i) {
            address m = members_[i];
            if (m == address(0) || isMember[m]) revert BadMembers();
            isMember[m] = true;
            _members.push(m);
        }
        periodStart = uint64(block.timestamp);
        emit CollectiveInitialized(name_, members_, agent_);
    }

    // ───────────────────────────── invoices ─────────────────────────────

    /// @notice Create an invoice. The id is derived from (this, creator, salt) so nobody can squat an id someone else
    ///         is about to use. Everyone on it other than the creator must agree before it can be paid.
    /// @param dueAt when the client should pay by (0 = no date); the agent reminds the team after it
    /// @param note what the team delivered, kept in the event (public, at most MAX_NOTE bytes)
    function createInvoice(
        bytes32 salt,
        uint256 amount,
        address payer,
        uint64 dueAt,
        address[] calldata contributors,
        uint16[] calldata sharesBps,
        string calldata note
    ) external onlyMemberOrAgent returns (bytes32 id) {
        id = invoiceId(msg.sender, salt);
        if (_invoices[id].status != InvoiceStatus.None) revert InvoiceExists();
        if (amount == 0) revert ZeroAmount();
        if (bytes(note).length > MAX_NOTE) revert NoteTooLong();
        Invoice storage inv = _invoices[id];
        inv.pending = _checkShares(id, contributors, sharesBps);
        inv.amount = amount;
        inv.creator = msg.sender;
        inv.payer = payer;
        inv.status = InvoiceStatus.Open;
        inv.dueAt = dueAt;
        inv.reserveBps = _rules.reserveBps;
        inv.contributors = contributors;
        inv.sharesBps = sharesBps;
        _emitCreated(id, inv, note);
    }

    /// @notice A contributor agrees to the invoice and their share on it.
    function approveInvoice(bytes32 id) external {
        _approve(id, msg.sender);
    }

    /// @notice Anyone may submit a contributor's signed agreement, so agreeing costs the contributor no gas.
    function approveInvoiceFor(bytes32 id, address member, bytes calldata signature) external {
        if (!SignatureChecker.isValidSignatureNow(member, approvalDigest(id), signature)) revert BadSignature();
        _approve(id, member);
    }

    /// @notice Members may cancel any open invoice; the agent only the invoices it created itself.
    function cancelInvoice(bytes32 id) external onlyMemberOrAgent {
        Invoice storage inv = _invoices[id];
        if (inv.status != InvoiceStatus.Open) revert InvoiceNotOpen();
        if (!isMember[msg.sender] && inv.creator != msg.sender) revert NotInvoiceOwner();
        inv.status = InvoiceStatus.Cancelled;
        emit InvoiceCancelled(id);
    }

    /// @notice Pay an open invoice everyone on it agreed to. Works when called directly or through Arc's Memo
    ///         contract, which preserves the paying EOA as msg.sender. The shares go out in the same transaction.
    function payInvoice(bytes32 id, uint256 expectedAmount) external nonReentrant {
        Invoice storage inv = _invoices[id];
        if (inv.status != InvoiceStatus.Open) revert InvoiceNotOpen();
        if (inv.pending != 0) revert AwaitingApproval();
        if (inv.amount != expectedAmount) revert AmountMismatch();
        if (inv.payer != address(0) && inv.payer != msg.sender) revert WrongPayer();
        inv.status = InvoiceStatus.Paid;
        usdc.safeTransferFrom(msg.sender, address(this), inv.amount);
        _payShares(id, inv, msg.sender);
    }

    /// @notice Agent ties money that arrived without a reference (cross-chain CCTP mint) to an open invoice, within
    ///         its per-period cap. `ref` is the inflow's tx hash and is usable once.
    function settleInvoice(bytes32 id, bytes32 ref) external onlyAgent nonReentrant {
        if (ref == bytes32(0)) revert RefRequired();
        _roll();
        uint256 amount = _invoices[id].amount;
        if (attributedThisPeriod + amount > _rules.autoAttributeCap) revert AboveCap();
        attributedThisPeriod += amount;
        _settle(id, ref);
    }

    /// @notice Agent ties unattributed inflow (a plain transfer, an x402 sale) to a member, within its cap.
    function attribute(address member, uint256 amount, bytes32 ref) external onlyAgent nonReentrant {
        if (ref == bytes32(0)) revert RefRequired();
        _roll();
        if (attributedThisPeriod + amount > _rules.autoAttributeCap) revert AboveCap();
        attributedThisPeriod += amount;
        _attribute(member, amount, ref);
    }

    // ───────────────────────────── shared costs ─────────────────────────────

    /// @notice Agent pays an allowlisted bill from the shared-costs reserve, within its cap. `ref` seals the decision.
    function payExpense(address to, uint256 amount, bytes32 ref) external onlyAgent nonReentrant {
        if (ref == bytes32(0)) revert RefRequired();
        if (!isPayee[to]) revert NotPayee(to);
        _roll();
        if (expensesThisPeriod + amount > _rules.expenseCapPerPeriod) revert AboveCap();
        expensesThisPeriod += amount;
        _spend(to, amount, ref);
    }

    // ───────────────────────────── payouts ─────────────────────────────

    /// @notice Send my future shares to `to` (another wallet, an exchange deposit address); zero resets to my own.
    /// Only ever affects the caller's own payouts.
    function setPayoutAddress(address to) external onlyMember {
        if (to == address(this) || to == address(usdc)) revert BadPayout();
        payoutTo[msg.sender] = to;
        emit PayoutAddressSet(msg.sender, to);
    }

    /// @notice Collect a payout that could not be pushed (e.g. recipient blocklisted). May go to another address.
    function claim(address to) external nonReentrant {
        uint256 amount = owed[msg.sender];
        if (amount == 0) revert ZeroAmount();
        owed[msg.sender] = 0;
        totalOwed -= amount;
        usdc.safeTransfer(to, amount);
        emit Claimed(msg.sender, to, amount);
    }

    // ───────────────────────────── governance ─────────────────────────────

    function propose(Kind kind, bytes calldata payload, bytes32 ref) external returns (uint256 id) {
        bool member = isMember[msg.sender];
        if (!member) {
            if (msg.sender != agent || agent == address(0)) revert NotMemberOrAgent();
            if (kind != Kind.Attribute && kind != Kind.Expense && kind != Kind.SettleInvoice) revert AgentCannotPropose(kind);
        }
        id = _proposals.length;
        uint64 executableAt = uint64(block.timestamp) + _rules.timelock;
        uint32 needed = _votesNeeded();
        _proposals.push(Proposal({
            kind: kind, payload: payload, ref: ref, proposer: msg.sender,
            executableAt: executableAt, expiresAt: executableAt + PROPOSAL_TTL, epoch: governanceEpoch,
            votes: 0, votesNeeded: needed, executed: false, cancelled: false
        }));
        emit Proposed(id, kind, msg.sender, ref, payload, executableAt, needed);
        if (member) _vote(id);
    }

    function unvote(uint256 id) external onlyMember {
        if (id >= _proposals.length) revert UnknownProposal();
        Proposal storage pr = _proposals[id];
        if (pr.executed) revert AlreadyExecuted();
        if (!hasVoted[id][msg.sender]) revert NotVoted();
        hasVoted[id][msg.sender] = false;
        pr.votes -= 1;
        emit Unvoted(id, msg.sender);
    }

    function cancel(uint256 id) external {
        if (id >= _proposals.length) revert UnknownProposal();
        Proposal storage pr = _proposals[id];
        if (pr.proposer != msg.sender) revert NotProposer();
        if (pr.executed) revert AlreadyExecuted();
        pr.cancelled = true;
        emit Cancelled(id);
    }

    function vote(uint256 id) external onlyMember {
        if (id >= _proposals.length) revert UnknownProposal();
        _vote(id);
    }

    function execute(uint256 id) external onlyMemberOrAgent nonReentrant {
        if (id >= _proposals.length) revert UnknownProposal();
        Proposal storage pr = _proposals[id];
        if (pr.executed) revert AlreadyExecuted();
        if (pr.cancelled) revert ProposalCancelled();
        if (pr.epoch != governanceEpoch) revert ProposalStale();
        if (block.timestamp < pr.executableAt) revert TimelockActive();
        if (block.timestamp > pr.expiresAt) revert ProposalExpired();
        if (pr.votes < pr.votesNeeded) revert NoQuorum();
        pr.executed = true;
        _apply(pr.kind, pr.payload, pr.ref, pr.proposer);
        emit Executed(id, pr.kind);
    }

    // ───────────────────────────── views ─────────────────────────────

    function rules() external view returns (Rules memory) { return _rules; }
    function members() external view returns (address[] memory) { return _members; }
    function proposalCount() external view returns (uint256) { return _proposals.length; }
    function proposal(uint256 id) external view returns (Proposal memory) { return _proposals[id]; }

    function invoice(bytes32 id) external view returns (
        uint256 amount,
        address creator,
        address payer,
        InvoiceStatus status,
        uint64 dueAt,
        uint16 reserveBps,
        uint8 pending,
        address[] memory contributors,
        uint16[] memory sharesBps
    ) {
        Invoice storage inv = _invoices[id];
        return (inv.amount, inv.creator, inv.payer, inv.status, inv.dueAt, inv.reserveBps, inv.pending, inv.contributors, inv.sharesBps);
    }

    function invoiceId(address creator, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), creator, salt));
    }

    /// @notice The EIP-712 digest a contributor signs to agree to invoice `id`.
    function approvalDigest(bytes32 id) public view returns (bytes32) {
        Invoice storage inv = _invoices[id];
        return _hashTypedDataV4(keccak256(abi.encode(
            APPROVE_TYPEHASH,
            id,
            inv.amount,
            inv.payer,
            inv.dueAt,
            inv.reserveBps,
            keccak256(abi.encodePacked(inv.contributors)),
            keccak256(abi.encodePacked(inv.sharesBps))
        )));
    }

    /// @notice USDC held but not yet tied to anyone (CCTP mints, plain transfers, x402 sales).
    function unattributed() public view returns (uint256) {
        uint256 bal = usdc.balanceOf(address(this));
        uint256 tracked = reserve + totalOwed;
        return bal > tracked ? bal - tracked : 0;
    }

    /// @notice What the agent may still attribute and spend in the current window, without a vote.
    function agentRoom() external view returns (uint256 attributeLeft, uint256 expenseLeft) {
        bool fresh = block.timestamp >= uint256(periodStart) + _rules.periodLength;
        uint256 a = fresh ? 0 : attributedThisPeriod;
        uint256 e = fresh ? 0 : expensesThisPeriod;
        attributeLeft = _rules.autoAttributeCap > a ? _rules.autoAttributeCap - a : 0;
        expenseLeft = _rules.expenseCapPerPeriod > e ? _rules.expenseCapPerPeriod - e : 0;
    }

    // ───────────────────────────── internals ─────────────────────────────

    /// @dev Members only, no zero shares, nobody twice, 100% in total. Returns how many still have to agree.
    function _checkShares(bytes32 id, address[] calldata contributors, uint16[] calldata sharesBps) internal returns (uint8) {
        uint256 n = contributors.length;
        if (n == 0 || n > MAX_CONTRIBUTORS || n != sharesBps.length) revert BadShares();
        uint256 sum;
        uint256 pending;
        for (uint256 i; i < n; ++i) {
            address m = contributors[i];
            if (!isMember[m]) revert NotAMember(m);
            if (sharesBps[i] == 0) revert BadShares();
            for (uint256 j; j < i; ++j) {
                if (contributors[j] == m) revert BadShares();
            }
            sum += sharesBps[i];
            if (m == msg.sender) approved[id][m] = true;
            else ++pending;
        }
        if (sum != BPS) revert BadShares();
        return uint8(pending);
    }

    function _emitCreated(bytes32 id, Invoice storage inv, string calldata note) internal {
        emit InvoiceCreated(id, inv.creator, inv.amount, inv.payer, inv.dueAt, inv.contributors, inv.sharesBps, note);
    }

    function _approve(bytes32 id, address member) internal {
        Invoice storage inv = _invoices[id];
        if (inv.status != InvoiceStatus.Open) revert InvoiceNotOpen();
        if (approved[id][member]) revert AlreadyApproved();
        bool listed;
        uint256 n = inv.contributors.length;
        for (uint256 i; i < n; ++i) {
            if (inv.contributors[i] == member) {
                listed = true;
                break;
            }
        }
        if (!listed) revert NotAContributor();
        approved[id][member] = true;
        inv.pending -= 1;
        emit InvoiceApproved(id, member);
    }

    function _settle(bytes32 id, bytes32 ref) internal {
        Invoice storage inv = _invoices[id];
        if (inv.status != InvoiceStatus.Open) revert InvoiceNotOpen();
        if (inv.pending != 0) revert AwaitingApproval();
        if (inv.amount > unattributed()) revert ExceedsUnattributed();
        if (ref != bytes32(0)) {
            if (usedRef[ref]) revert RefAlreadyUsed();
            usedRef[ref] = true;
        }
        inv.status = InvoiceStatus.Paid;
        emit InvoiceSettled(id, ref, inv.amount);
        _payShares(id, inv, address(0));
    }

    /// @dev Shared costs first (if the team set a share), then every contributor's share, now. The last contributor
    ///      takes the rounding remainder so nothing is left behind.
    function _payShares(bytes32 id, Invoice storage inv, address payer) internal {
        uint256 amount = inv.amount;
        uint256 toReserve = _takeReserve(amount, inv.reserveBps);
        emit InvoicePaid(id, payer, amount, toReserve);
        uint256 net = amount - toReserve;
        uint256 left = net;
        uint256 n = inv.contributors.length;
        for (uint256 i; i < n; ++i) {
            uint256 share = i == n - 1 ? left : (net * inv.sharesBps[i]) / BPS;
            left -= share;
            _payOut(id, inv.contributors[i], share);
        }
    }

    function _attribute(address member, uint256 amount, bytes32 ref) internal {
        if (amount == 0) revert ZeroAmount();
        if (ref != bytes32(0)) {
            if (usedRef[ref]) revert RefAlreadyUsed();
            usedRef[ref] = true;
        }
        if (!isMember[member]) revert NotAMember(member);
        if (amount > unattributed()) revert ExceedsUnattributed();
        uint256 toReserve = _takeReserve(amount, _rules.reserveBps);
        emit Attributed(member, amount, ref);
        _payOut(ref, member, amount - toReserve);
    }

    function _spend(address to, uint256 amount, bytes32 ref) internal {
        if (amount == 0) revert ZeroAmount();
        if (ref != bytes32(0)) {
            if (usedRef[ref]) revert RefAlreadyUsed();
            usedRef[ref] = true;
        }
        if (amount > reserve) revert InsufficientReserve();
        reserve -= amount;
        usdc.safeTransfer(to, amount);
        emit ExpensePaid(to, amount, ref);
    }

    /// @dev At most `bps` of the amount, less once the reserve reaches its target: never more than people agreed to.
    function _takeReserve(uint256 amount, uint16 bps) internal returns (uint256 toReserve) {
        uint256 target = _rules.reserveTarget;
        if (reserve >= target) return 0;
        toReserve = (amount * bps) / BPS;
        uint256 room = target - reserve;
        if (toReserve > room) toReserve = room;
        reserve += toReserve;
    }

    /// @dev A new limits window starts on the agent's first action after the last one ended.
    function _roll() internal {
        if (block.timestamp < uint256(periodStart) + _rules.periodLength) return;
        period += 1;
        periodStart = uint64(block.timestamp);
        expensesThisPeriod = 0;
        attributedThisPeriod = 0;
    }

    /// @dev Pushes a share to the member's chosen address. A failed push stays owed to the member (never to the
    /// destination), so only the member can claim it elsewhere.
    function _payOut(bytes32 source, address member, uint256 amount) internal {
        if (amount == 0) return;
        address dest = payoutTo[member];
        if (dest == address(0)) dest = member;
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20.transfer, (dest, amount)));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) {
            emit Paid(source, member, dest, amount);
        } else {
            owed[member] += amount;
            totalOwed += amount;
            emit PayoutDeferred(source, member, amount);
        }
    }

    function _vote(uint256 id) internal {
        Proposal storage pr = _proposals[id];
        if (pr.executed) revert AlreadyExecuted();
        if (pr.cancelled) revert ProposalCancelled();
        if (pr.epoch != governanceEpoch) revert ProposalStale();
        if (hasVoted[id][msg.sender]) revert AlreadyVoted();
        hasVoted[id][msg.sender] = true;
        pr.votes += 1;
        emit Voted(id, msg.sender);
    }

    function _apply(Kind kind, bytes memory payload, bytes32 ref, address proposer) internal {
        if (kind == Kind.SetRules) {
            Rules memory r = abi.decode(payload, (Rules));
            _validateRules(r);
            _rules = r;
            governanceEpoch += 1;
        } else if (kind == Kind.AddMember) {
            address m = abi.decode(payload, (address));
            if (m == address(0) || isMember[m] || _members.length >= MAX_MEMBERS) revert BadMembers();
            isMember[m] = true;
            _members.push(m);
            governanceEpoch += 1;
        } else if (kind == Kind.RemoveMember) {
            address m = abi.decode(payload, (address));
            if (!isMember[m] || _members.length == 1) revert BadMembers();
            isMember[m] = false;
            uint256 n = _members.length;
            for (uint256 i; i < n; ++i) {
                if (_members[i] == m) {
                    _members[i] = _members[n - 1];
                    _members.pop();
                    break;
                }
            }
            governanceEpoch += 1;
        } else if (kind == Kind.SetAgent) {
            agent = abi.decode(payload, (address));
            governanceEpoch += 1;
        } else if (kind == Kind.SetPayee) {
            (address to, bool allowed) = abi.decode(payload, (address, bool));
            isPayee[to] = allowed;
        } else if (kind == Kind.ReleaseReserve) {
            // e.g. the team splits up, or a slow month: paid straight to the named recipients
            (address[] memory to, uint256[] memory amounts) = abi.decode(payload, (address[], uint256[]));
            if (to.length != amounts.length || to.length == 0) revert BadShares();
            uint256 total;
            for (uint256 i; i < amounts.length; ++i) total += amounts[i];
            if (total > reserve) revert InsufficientReserve();
            reserve -= total;
            for (uint256 i; i < to.length; ++i) {
                if (to[i] == address(this)) revert BadPayout();
                _payOut(bytes32(0), to[i], amounts[i]);
                emit ReserveReleased(to[i], amounts[i]);
            }
        } else if (kind == Kind.Attribute) {
            (address member, uint256 amount) = abi.decode(payload, (address, uint256));
            _attribute(member, amount, ref);
        } else if (kind == Kind.SettleInvoice) {
            _settle(abi.decode(payload, (bytes32)), ref);
        } else if (kind == Kind.Expense) {
            (address to, uint256 amount) = abi.decode(payload, (address, uint256));
            // A vote the agent opened can only pay an allowlisted payee: a fooled agent's convincing
            // reasoning must not be enough to route money to a new address.
            if (proposer == agent && !isPayee[to]) revert NotPayee(to);
            _spend(to, amount, ref);
        }
    }

    /// @dev Quorum strictly above half, a real timelock and sane windows: no rule set lets one member act alone.
    function _validateRules(Rules memory r) internal pure {
        if (
            r.reserveBps > BPS || r.quorumBps <= BPS / 2 || r.quorumBps > BPS || r.timelock < MIN_TIMELOCK
                || r.timelock > MAX_TIMELOCK || r.periodLength < MIN_PERIOD || r.periodLength > MAX_PERIOD
        ) revert BadRules();
    }

    /// @dev Votes a new proposal needs, fixed at creation: ceil(quorum x members), never fewer than 2 with 2+ members.
    function _votesNeeded() internal view returns (uint32) {
        uint256 n = _members.length;
        uint256 needed = (uint256(_rules.quorumBps) * n + BPS - 1) / BPS;
        if (n >= 2 && needed < 2) needed = 2;
        return uint32(needed);
    }
}
