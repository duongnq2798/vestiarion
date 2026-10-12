/** One action from every surface (integrations design §8): the actor, the gate, and the commands. */
export { accessOf, consoleActor, cycleEventOf, memberActor, provenanceOf, type Actor, type Surface, type SurfaceKind } from "./actor";
export { ActorScopeError, COMMAND_PERMISSIONS, gate, SURFACE_COMMANDS, type CommandName } from "./policy";
export { done, refused, TRY_AGAIN, type CommandOutcome, type Done, type Refused } from "./outcome";
export { addPayableDetails, approvePayable, heldMessage, rejectPayable, returnPayable } from "./payables";
export { addMilestone, closeMilestoneUnpaid, payMilestoneNow } from "./milestones";
export { pauseWorkspaceAgent, resumeWorkspaceAgent, runWorkspaceCycle } from "./agent";
export { addInvoice } from "./invoices";
export { importInvoices, type ImportOutcome } from "./imports";
export { issuePayeeLink } from "./payee-links";
export { importActualPayments, recordActualPayment } from "./actuals";
export { approvePlanLines, type PlanLineResult } from "./payment-plan";
export { answerReportBaseline, shareWorkspaceReport, stopSharingWorkspaceReport } from "./report";
export { importBankStatement } from "./statements";
export { addAccountingBills, dismissAccountingBills, type BroughtInBill, type BroughtInCounts } from "./accounting";
export { applyReceivedPayment, reverseAppliedPayment } from "./allocations";
export { addDeal, changeDeal, releaseDealLine, setDealAutoRelease } from "./deals";
