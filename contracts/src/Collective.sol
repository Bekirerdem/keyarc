// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Rules} from "./CollectiveTypes.sol";

/// @title Collective
/// @notice Shared treasury for a team that earns together. Income is tied to the work that
///         produced it, a reserve is set aside first, the rest is paid out by contribution.
///         Nobody (creator, agent or any single member) can move funds or change rules alone.
contract Collective is Initializable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_MEMBERS = 50;
    uint256 public constant MAX_CONTRIBUTORS = 20;
    uint16 internal constant BPS = 10_000;
    uint32 public constant MIN_TIMELOCK = 1 hours;
    uint32 public constant MAX_TIMELOCK = 30 days;
    uint32 public constant MIN_PERIOD = 1 hours;
    uint32 public constant MAX_PERIOD = 366 days;
    uint64 public constant PROPOSAL_TTL = 7 days;

    enum InvoiceStatus { None, Open, Paid, Cancelled }
    enum Kind { SetRules, AddMember, RemoveMember, SetAgent, SetPayee, ReleaseReserve, Attribute, Expense, SettleInvoice }

    struct Invoice {
        uint256 amount;
        address creator;
        address payer;
        InvoiceStatus status;
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

    uint256 public reserve;
    uint256 public pool;
    uint256 public totalOwed;
    mapping(address => uint256) public owed;

    uint256 public period;
    uint64 public periodStart;
    uint256 public expensesThisPeriod;
    uint256 public attributedThisPeriod;
    uint64 public governanceEpoch;
    mapping(uint256 => mapping(address => uint256)) public credit;
    mapping(uint256 => uint256) public totalCredit;
    mapping(uint256 => address[]) internal _creditors;

    mapping(bytes32 => Invoice) internal _invoices;
    Proposal[] internal _proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;
    /// @notice Inflow references (e.g. the incoming tx hash) already attributed; makes agent retries idempotent.
    mapping(bytes32 => bool) public usedRef;
    /// @notice Where a member's share is sent at payout; zero means the member's own address.
    mapping(address => address) public payoutTo;

    event CollectiveInitialized(string name, address[] members, address agent);
    event InvoiceCreated(
        bytes32 indexed id, address indexed creator, uint256 amount, address payer, address[] contributors, uint16[] sharesBps
    );
    event InvoicePaid(bytes32 indexed id, address indexed payer, uint256 amount, uint256 toReserve);
    /// @notice An invoice settled from unattributed inflow (e.g. a CCTP mint from another chain).
    event InvoiceSettled(bytes32 indexed id, bytes32 ref, uint256 amount);
    event InvoiceCancelled(bytes32 indexed id);
    event Credited(uint256 indexed period, address indexed member, uint256 amount);
    event Attributed(address indexed member, uint256 amount, bytes32 ref);
    event ExpensePaid(address indexed to, uint256 amount, bytes32 ref);
    event Paid(uint256 indexed period, address indexed member, uint256 amount);
    event PayoutDeferred(uint256 indexed period, address indexed member, uint256 amount);
    event Claimed(address indexed member, address to, uint256 amount);
    event PayoutAddressSet(address indexed member, address to);
    event Distributed(uint256 indexed period, uint256 total, uint256 carried);
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
    error InvoiceExists();
    error AmountMismatch();
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
    error InsufficientPool();
    error InsufficientReserve();
    error PeriodNotOver();
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

    constructor() {
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

    // ───────────────────────────── income ─────────────────────────────

    /// @notice Create an invoice. The id is derived from (this, creator, salt) so nobody can squat
    ///         an id someone else is about to use.
    function createInvoice(
        bytes32 salt,
        uint256 amount,
        address payer,
        address[] calldata contributors,
        uint16[] calldata sharesBps
    ) external onlyMemberOrAgent returns (bytes32 id) {
        id = invoiceId(msg.sender, salt);
        if (_invoices[id].status != InvoiceStatus.None) revert InvoiceExists();
        if (amount == 0) revert ZeroAmount();
        uint256 n = contributors.length;
        if (n == 0 || n > MAX_CONTRIBUTORS || n != sharesBps.length) revert BadShares();
        uint256 sum;
        for (uint256 i; i < n; ++i) {
            if (!isMember[contributors[i]]) revert NotAMember(contributors[i]);
            sum += sharesBps[i];
        }
        if (sum != BPS) revert BadShares();
        Invoice storage inv = _invoices[id];
        inv.amount = amount;
        inv.creator = msg.sender;
        inv.payer = payer;
        inv.status = InvoiceStatus.Open;
        inv.contributors = contributors;
        inv.sharesBps = sharesBps;
        emit InvoiceCreated(id, msg.sender, amount, payer, contributors, sharesBps);
    }

    /// @notice Members may cancel any open invoice; the agent only the invoices it created itself.
    function cancelInvoice(bytes32 id) external onlyMemberOrAgent {
        Invoice storage inv = _invoices[id];
        if (inv.status != InvoiceStatus.Open) revert InvoiceNotOpen();
        if (!isMember[msg.sender] && inv.creator != msg.sender) revert NotInvoiceOwner();
        inv.status = InvoiceStatus.Cancelled;
        emit InvoiceCancelled(id);
    }

    /// @notice Pay an open invoice. Works when called directly or through Arc's Memo contract,
    ///         which preserves the paying EOA as msg.sender.
    function payInvoice(bytes32 id, uint256 expectedAmount) external nonReentrant {
        Invoice storage inv = _invoices[id];
        if (inv.status != InvoiceStatus.Open) revert InvoiceNotOpen();
        if (inv.amount != expectedAmount) revert AmountMismatch();
        if (inv.payer != address(0) && inv.payer != msg.sender) revert WrongPayer();
        inv.status = InvoiceStatus.Paid;
        usdc.safeTransferFrom(msg.sender, address(this), inv.amount);
        _creditInvoice(id, inv, msg.sender);
    }

    /// @notice Agent ties money that arrived without a reference (cross-chain CCTP mint) to an open
    ///         invoice, within its per-period cap. `ref` is the inflow's tx hash and is usable once.
    function settleInvoice(bytes32 id, bytes32 ref) external onlyAgent nonReentrant {
        if (ref == bytes32(0)) revert RefRequired();
        uint256 amount = _invoices[id].amount;
        if (attributedThisPeriod + amount > _rules.autoAttributeCap) revert AboveCap();
        attributedThisPeriod += amount;
        _settle(id, ref);
    }

    function _settle(bytes32 id, bytes32 ref) internal {
        Invoice storage inv = _invoices[id];
        if (inv.status != InvoiceStatus.Open) revert InvoiceNotOpen();
        if (inv.amount > unattributed()) revert ExceedsUnattributed();
        if (ref != bytes32(0)) {
            if (usedRef[ref]) revert RefAlreadyUsed();
            usedRef[ref] = true;
        }
        inv.status = InvoiceStatus.Paid;
        _creditInvoice(id, inv, address(0));
        emit InvoiceSettled(id, ref, inv.amount);
    }

    function _creditInvoice(bytes32 id, Invoice storage inv, address payer) internal {
        uint256 amount = inv.amount;
        uint256 toReserve = _takeReserve(amount);
        pool += amount - toReserve;
        uint256 n = inv.contributors.length;
        for (uint256 i; i < n; ++i) {
            _addCredit(inv.contributors[i], (amount * inv.sharesBps[i]) / BPS);
        }
        emit InvoicePaid(id, payer, amount, toReserve);
    }

    /// @notice Agent ties unattributed inflow (x402 sale, plain transfer) to a member, within its cap.
    function attribute(address member, uint256 amount, bytes32 ref) external onlyAgent nonReentrant {
        if (ref == bytes32(0)) revert RefRequired();
        if (attributedThisPeriod + amount > _rules.autoAttributeCap) revert AboveCap();
        attributedThisPeriod += amount;
        _attribute(member, amount, ref);
    }

    // ───────────────────────────── spending ─────────────────────────────

    function payExpense(address to, uint256 amount, bytes32 ref) external onlyAgent nonReentrant {
        if (!isPayee[to]) revert NotPayee(to);
        if (expensesThisPeriod + amount > _rules.expenseCapPerPeriod) revert AboveCap();
        expensesThisPeriod += amount;
        _spend(to, amount, ref);
    }

    // ───────────────────────────── payout ─────────────────────────────

    function distribute() external onlyMemberOrAgent nonReentrant {
        if (block.timestamp < uint256(periodStart) + _rules.periodLength) revert PeriodNotOver();
        uint256 p = period;
        uint256 total = totalCredit[p];
        uint256 pot = pool;
        uint256 paid;
        if (total > 0 && pot > 0) {
            address[] storage cs = _creditors[p];
            uint256 n = cs.length;
            for (uint256 i; i < n; ++i) {
                address m = cs[i];
                uint256 share = (pot * credit[p][m]) / total;
                if (share == 0) continue;
                paid += share;
                _payOut(p, m, share);
            }
            pool = pot - paid;
        }
        period = p + 1;
        periodStart = uint64(block.timestamp);
        expensesThisPeriod = 0;
        attributedThisPeriod = 0;
        emit Distributed(p, paid, pool);
    }

    /// @notice Send my future shares to `to` (another wallet, an exchange deposit address); zero resets to my own.
    /// Only ever affects the caller's own payouts.
    function setPayoutAddress(address to) external onlyMember {
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
    function creditors(uint256 p) external view returns (address[] memory) { return _creditors[p]; }
    function proposalCount() external view returns (uint256) { return _proposals.length; }
    function proposal(uint256 id) external view returns (Proposal memory) { return _proposals[id]; }

    function invoice(bytes32 id) external view returns (
        uint256 amount,
        address creator,
        address payer,
        InvoiceStatus status,
        address[] memory contributors,
        uint16[] memory sharesBps
    ) {
        Invoice storage inv = _invoices[id];
        return (inv.amount, inv.creator, inv.payer, inv.status, inv.contributors, inv.sharesBps);
    }

    function invoiceId(address creator, bytes32 salt) public view returns (bytes32) {
        return keccak256(abi.encode(address(this), creator, salt));
    }

    /// @notice USDC held but not yet tied to anyone (x402 sales, plain transfers).
    function unattributed() public view returns (uint256) {
        uint256 bal = usdc.balanceOf(address(this));
        uint256 tracked = reserve + pool + totalOwed;
        return bal > tracked ? bal - tracked : 0;
    }

    // ───────────────────────────── internals ─────────────────────────────

    function _takeReserve(uint256 amount) internal returns (uint256 toReserve) {
        uint256 target = _rules.reserveTarget;
        if (reserve >= target) return 0;
        toReserve = (amount * _rules.reserveBps) / BPS;
        uint256 room = target - reserve;
        if (toReserve > room) toReserve = room;
        reserve += toReserve;
    }

    function _addCredit(address member, uint256 amount) internal {
        if (amount == 0) return;
        uint256 p = period;
        if (credit[p][member] == 0) _creditors[p].push(member);
        credit[p][member] += amount;
        totalCredit[p] += amount;
        emit Credited(p, member, amount);
    }

    function _attribute(address member, uint256 amount, bytes32 ref) internal {
        if (amount == 0) revert ZeroAmount();
        if (ref != bytes32(0)) {
            if (usedRef[ref]) revert RefAlreadyUsed();
            usedRef[ref] = true;
        }
        if (!isMember[member]) revert NotAMember(member);
        if (amount > unattributed()) revert ExceedsUnattributed();
        uint256 toReserve = _takeReserve(amount);
        pool += amount - toReserve;
        _addCredit(member, amount);
        emit Attributed(member, amount, ref);
    }

    function _spend(address to, uint256 amount, bytes32 ref) internal {
        if (amount == 0) revert ZeroAmount();
        if (amount > pool) revert InsufficientPool();
        pool -= amount;
        usdc.safeTransfer(to, amount);
        emit ExpensePaid(to, amount, ref);
    }

    /// @dev Pushes a member's share to their chosen address. A failed push stays owed to the member
    /// (never to the destination), so only the member can claim it elsewhere.
    function _payOut(uint256 p, address member, uint256 amount) internal {
        address dest = payoutTo[member];
        if (dest == address(0)) dest = member;
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20.transfer, (dest, amount)));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) {
            emit Paid(p, member, amount);
        } else {
            owed[member] += amount;
            totalOwed += amount;
            emit PayoutDeferred(p, member, amount);
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
            // Paid straight to named recipients: parking it in the pool would let anyone buy
            // credit late in the period and capture it.
            (address[] memory to, uint256[] memory amounts) = abi.decode(payload, (address[], uint256[]));
            if (to.length != amounts.length || to.length == 0) revert BadShares();
            uint256 total;
            for (uint256 i; i < amounts.length; ++i) total += amounts[i];
            if (total > reserve) revert InsufficientReserve();
            reserve -= total;
            for (uint256 i; i < to.length; ++i) {
                _payOut(period, to[i], amounts[i]);
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

    /// @dev Quorum strictly above half, a real timelock and sane periods: no rule set lets one member act alone.
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
