import { TypeCompiler } from '@sinclair/typebox/compiler';
import semver from 'semver';
import { applyFunctionToValuesSync, isNil, isString } from '../common';
import { ActivepiecesError, ErrorCode } from '../common/activepieces-error';
import {
  Action,
  ActionType,
  BranchAction,
  BranchExecutionType,
  emptyCondition,
  LoopOnItemsAction,
  RouterAction,
  SingleActionSchema,
} from './actions/action';
import { PopulatedFlow } from './flow';
import {
  AddActionRequest,
  DeleteActionRequest,
  FlowOperationRequest,
  FlowOperationType,
  MoveActionRequest,
  StepLocationRelativeToParent,
  UpdateActionRequest,
  UpdateTriggerRequest,
} from './flow-operations';
import { FlowVersion, FlowVersionState } from './flow-version';
import { DEFAULT_SAMPLE_DATA_SETTINGS } from './sample-data';
import { Trigger, TriggerType } from './triggers/trigger';

type Step = Action | Trigger;

type GetStepFromSubFlow = {
  subFlowStartStep: Step;
  stepName: string;
};

const actionSchemaValidator = TypeCompiler.Compile(SingleActionSchema);
const triggerSchemaValidation = TypeCompiler.Compile(Trigger);

function isValid(flowVersion: FlowVersion) {
  let valid = true;
  const steps = flowHelper.getAllSteps(flowVersion.trigger);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    valid = valid && step.valid;
  }
  return valid;
}

function isAction(type: ActionType | TriggerType | undefined): boolean {
  return Object.entries(ActionType).some(([, value]) => value === type);
}

function isTrigger(type: ActionType | TriggerType | undefined): boolean {
  return Object.entries(TriggerType).some(([, value]) => value === type);
}

function deleteAction(
  flowVersion: FlowVersion,
  request: DeleteActionRequest
): FlowVersion {
  return transferFlow(flowVersion, (parentStep) => {
    if (parentStep.nextAction && parentStep.nextAction.name === request.name) {
      const stepToUpdate: Action = parentStep.nextAction;
      parentStep.nextAction = stepToUpdate.nextAction;
    }
    switch (parentStep.type) {
      case ActionType.BRANCH: {
        if (
          parentStep.onFailureAction &&
          parentStep.onFailureAction.name === request.name
        ) {
          const stepToUpdate: Action = parentStep.onFailureAction;
          parentStep.onFailureAction = stepToUpdate.nextAction;
        }
        if (
          parentStep.onSuccessAction &&
          parentStep.onSuccessAction.name === request.name
        ) {
          const stepToUpdate: Action = parentStep.onSuccessAction;
          parentStep.onSuccessAction = stepToUpdate.nextAction;
        }
        break;
      }
      case ActionType.LOOP_ON_ITEMS: {
        if (
          parentStep.firstLoopAction &&
          parentStep.firstLoopAction.name === request.name
        ) {
          const stepToUpdate: Action = parentStep.firstLoopAction;
          parentStep.firstLoopAction = stepToUpdate.nextAction;
        }
        break;
      }
      case ActionType.ROUTER: {
        parentStep.children = parentStep.children.map((child) => {
          if (child && child.name === request.name) {
            return child.nextAction ?? null;
          }
          return child;
        });
        break;
      }
      default:
        break;
    }
    return parentStep;
  });
}

function getUsedPieces(trigger: Trigger): string[] {
  return traverseInternal(trigger)
    .filter(
      (step) =>
        step.type === ActionType.PIECE || step.type === TriggerType.PIECE
    )
    .map((step) => step.settings.pieceName)
    .filter((value, index, self) => self.indexOf(value) === index);
}

function traverseInternal(
  step: Trigger | Action | undefined | null
): (Action | Trigger)[] {
  const steps: (Action | Trigger)[] = [];
  while (step !== undefined && step !== null) {
    steps.push(step);
    if (step.type === ActionType.BRANCH) {
      steps.push(...traverseInternal(step.onSuccessAction));
      steps.push(...traverseInternal(step.onFailureAction));
    }
    if (step.type === ActionType.ROUTER) {
      steps.push(
        ...step.children.map((child) => traverseInternal(child)).flat()
      );
    }
    if (step.type === ActionType.LOOP_ON_ITEMS) {
      steps.push(...traverseInternal(step.firstLoopAction));
    }
    step = step.nextAction;
  }
  return steps;
}

async function updateFlowSecrets(
  originalFlow: PopulatedFlow,
  newFlow: PopulatedFlow
): Promise<FlowVersion> {
  return transferFlow(newFlow.version, (step) => {
    const oldStep = getStep(originalFlow.version, step.name);
    if (oldStep?.settings?.input?.auth) {
      step.settings.input.auth = oldStep.settings.input.auth;
    }
    return step;
  });
}

async function transferStepAsync<T extends Step>(
  step: Step,
  transferFunction: (step: T) => Promise<T>
): Promise<Step> {
  const updatedStep = await transferFunction(step as T);

  if (updatedStep.type === ActionType.BRANCH) {
    const { onSuccessAction, onFailureAction } = updatedStep;
    if (onSuccessAction) {
      updatedStep.onSuccessAction = (await transferStepAsync(
        onSuccessAction,
        transferFunction
      )) as Action;
    }
    if (onFailureAction) {
      updatedStep.onFailureAction = (await transferStepAsync(
        onFailureAction,
        transferFunction
      )) as Action;
    }
  } else if (updatedStep.type === ActionType.LOOP_ON_ITEMS) {
    const { firstLoopAction } = updatedStep;
    if (firstLoopAction) {
      updatedStep.firstLoopAction = (await transferStepAsync(
        firstLoopAction,
        transferFunction
      )) as Action;
    }
  } else if (updatedStep.type === ActionType.ROUTER) {
    const { children } = updatedStep;
    if (children) {
      updatedStep.children = await Promise.all(
        children.map(async (child) =>
          child
            ? ((await transferStepAsync(child, transferFunction)) as Action)
            : null
        )
      );
    }
  }

  if (updatedStep.nextAction) {
    updatedStep.nextAction = (await transferStepAsync(
      updatedStep.nextAction,
      transferFunction
    )) as Action;
  }

  return updatedStep;
}

function transferStep<T extends Step>(
  step: Step,
  transferFunction: (step: T) => T
): Step {
  const updatedStep = transferFunction(step as T);
  if (updatedStep.type === ActionType.BRANCH) {
    const { onSuccessAction, onFailureAction } = updatedStep;
    if (onSuccessAction) {
      updatedStep.onSuccessAction = transferStep(
        onSuccessAction,
        transferFunction
      ) as Action;
    }
    if (onFailureAction) {
      updatedStep.onFailureAction = transferStep(
        onFailureAction,
        transferFunction
      ) as Action;
    }
  } else if (updatedStep.type === ActionType.LOOP_ON_ITEMS) {
    const { firstLoopAction } = updatedStep;
    if (firstLoopAction) {
      updatedStep.firstLoopAction = transferStep(
        firstLoopAction,
        transferFunction
      ) as Action;
    }
  } else if (updatedStep.type === ActionType.ROUTER) {
    const { children } = updatedStep;
    if (children) {
      updatedStep.children = children.map((child) =>
        child ? (transferStep(child, transferFunction) as Action) : null
      );
    }
  }

  if (updatedStep.nextAction) {
    updatedStep.nextAction = transferStep(
      updatedStep.nextAction,
      transferFunction
    ) as Action;
  }

  return updatedStep;
}

async function transferFlowAsync<T extends Step>(
  flowVersion: FlowVersion,
  transferFunction: (step: T) => Promise<T>
): Promise<FlowVersion> {
  const clonedFlow = JSON.parse(JSON.stringify(flowVersion));
  clonedFlow.trigger = (await transferStepAsync(
    clonedFlow.trigger,
    transferFunction
  )) as Trigger;
  return clonedFlow;
}

function transferFlow<T extends Step>(
  flowVersion: FlowVersion,
  transferFunction: (step: T) => T
): FlowVersion {
  const clonedFlow = JSON.parse(JSON.stringify(flowVersion));
  clonedFlow.trigger = transferStep(
    clonedFlow.trigger,
    transferFunction
  ) as Trigger;
  return clonedFlow;
}
function getAllSteps(trigger: Trigger | Action): (Action | Trigger)[] {
  return traverseInternal(trigger);
}

function getAllStepsAtFirstLevel(step: Trigger): (Action | Trigger)[] {
  const steps: (Action | Trigger)[] = [];
  steps.push(step);
  let nextAction: Step | undefined = step.nextAction;
  while (nextAction !== undefined) {
    steps.push(nextAction);
    nextAction = nextAction.nextAction;
  }
  return steps;
}
function getAllChildSteps(
  action: LoopOnItemsAction | BranchAction | RouterAction
): Action[] {
  switch (action.type) {
    case ActionType.LOOP_ON_ITEMS:
      return traverseInternal(action.firstLoopAction) as Action[];
    case ActionType.ROUTER:
      return action.children
        .map((child) => traverseInternal((child as null | Action)?.nextAction))
        .flat() as Action[];
    default:
      return [
        ...traverseInternal(action.onSuccessAction),
        ...traverseInternal(action.onFailureAction),
      ] as Action[];
  }
}

function getAllDirectChildStepsForLoop(action: LoopOnItemsAction): Action[] {
  const actions: Action[] = [];

  let child = action.firstLoopAction;
  while (child) {
    actions.push(child);
    child = child.nextAction;
  }

  return actions;
}

function getAllDirectChildStepsForBranch(
  action: BranchAction,
  branch: 'success' | 'failure'
): Action[] {
  const actions: Action[] = [];
  if (branch === 'success') {
    let child = action.onSuccessAction;
    while (child) {
      actions.push(child);
      child = child.nextAction;
    }
  } else {
    let child = action.onFailureAction;
    while (child) {
      actions.push(child);
      child = child.nextAction;
    }
  }
  return actions;
}

function getStep(
  flowVersion: FlowVersion,
  stepName: string
): Action | Trigger | undefined {
  return getAllSteps(flowVersion.trigger).find(
    (step) => step.name === stepName
  );
}

const getStepFromSubFlow = ({
  subFlowStartStep,
  stepName,
}: GetStepFromSubFlow): Step | undefined => {
  const subFlowSteps = getAllSteps(subFlowStartStep);

  return subFlowSteps.find((step) => step.name === stepName);
};
function updateAction(
  flowVersion: FlowVersion,
  request: UpdateActionRequest
): FlowVersion {
  return transferFlow(flowVersion, (parentStep) => {
    if (parentStep.nextAction && parentStep.nextAction.name === request.name) {
      const actions = extractActions(parentStep.nextAction);
      parentStep.nextAction = createAction(request, actions);
    }
    if (parentStep.type === ActionType.ROUTER) {
      const childIndex = parentStep.children.findIndex(
        (child) => child?.name === request.name
      );
      if (childIndex > -1 && parentStep.children[childIndex]) {
        const actions = extractActions(parentStep.children[childIndex]);
        parentStep.children[childIndex] = createAction(request, actions);
      }
    }
    if (parentStep.type === ActionType.BRANCH) {
      if (
        parentStep.onFailureAction &&
        parentStep.onFailureAction.name === request.name
      ) {
        const actions = extractActions(parentStep.onFailureAction);
        parentStep.onFailureAction = createAction(request, actions);
      }
      if (
        parentStep.onSuccessAction &&
        parentStep.onSuccessAction.name === request.name
      ) {
        const actions = extractActions(parentStep.onSuccessAction);
        parentStep.onSuccessAction = createAction(request, actions);
      }
    }
    if (parentStep.type === ActionType.LOOP_ON_ITEMS) {
      if (
        parentStep.firstLoopAction &&
        parentStep.firstLoopAction.name === request.name
      ) {
        const actions = extractActions(parentStep.firstLoopAction);
        parentStep.firstLoopAction = createAction(request, actions);
      }
    }
    return parentStep;
  });
}

function extractActions(step: Trigger | Action): {
  nextAction?: Action;
  onSuccessAction?: Action;
  onFailureAction?: Action;
  firstLoopAction?: Action;
  children?: (Action | null)[];
} {
  const nextAction = step.nextAction;
  const onSuccessAction =
    step.type === ActionType.BRANCH ? step.onSuccessAction : undefined;
  const onFailureAction =
    step.type === ActionType.BRANCH ? step.onFailureAction : undefined;
  const firstLoopAction =
    step.type === ActionType.LOOP_ON_ITEMS ? step.firstLoopAction : undefined;
  const children = step.type === ActionType.ROUTER ? step.children : undefined;
  return {
    nextAction,
    onSuccessAction,
    onFailureAction,
    firstLoopAction,
    children,
  };
}

function moveAction(
  flowVersion: FlowVersion,
  request: MoveActionRequest
): FlowVersion {
  const steps = getAllSteps(flowVersion.trigger);
  const sourceStep = steps.find((step) => step.name === request.name);
  if (!sourceStep || !isAction(sourceStep.type)) {
    throw new ActivepiecesError(
      {
        code: ErrorCode.FLOW_OPERATION_INVALID,
        params: {},
      },
      `Source step ${request.name} not found`
    );
  }
  const destinationStep = steps.find(
    (step) => step.name === request.newParentStep
  );
  if (!destinationStep) {
    throw new ActivepiecesError(
      {
        code: ErrorCode.FLOW_OPERATION_INVALID,
        params: {},
      },
      `Destination step ${request.newParentStep} not found`
    );
  }
  const childOperation: FlowOperationRequest[] = [];
  const clonedSourceStep: Step = JSON.parse(JSON.stringify(sourceStep));
  if (
    clonedSourceStep.type === ActionType.LOOP_ON_ITEMS ||
    clonedSourceStep.type === ActionType.BRANCH
  ) {
    // Don't Clone the next action for first step only
    clonedSourceStep.nextAction = undefined;
    childOperation.push(...getImportOperations(clonedSourceStep));
  }
  flowVersion = deleteAction(flowVersion, { name: request.name });
  flowVersion = addAction(
    flowVersion,
    {
      action: sourceStep as Action,
      parentStep: request.newParentStep,
      stepLocationRelativeToParent: request.stepLocationRelativeToNewParent,
      branchIndex: request.branchIndex,
      branchName: request.branchName,
    },
    sourceStep.type === ActionType.ROUTER ? sourceStep.children : undefined
  );

  childOperation.forEach((operation) => {
    const operationWithBranchIndex = {
      ...operation,
      branchIndex: request.branchIndex,
      branchName: request.branchName,
    };
    flowVersion = flowHelper.apply(flowVersion, operationWithBranchIndex);
  });
  return flowVersion;
}

function addAction(
  flowVersion: FlowVersion,
  request: AddActionRequest,
  children?: (Action | null)[]
): FlowVersion {
  return transferFlow(flowVersion, (parentStep: Step) => {
    if (parentStep.name !== request.parentStep) {
      return parentStep;
    }
    if (
      parentStep.type === ActionType.LOOP_ON_ITEMS &&
      request.stepLocationRelativeToParent
    ) {
      if (
        request.stepLocationRelativeToParent ===
        StepLocationRelativeToParent.INSIDE_LOOP
      ) {
        parentStep.firstLoopAction = createAction(request.action, {
          nextAction: parentStep.firstLoopAction,
          children,
        });
      } else if (
        request.stepLocationRelativeToParent ===
        StepLocationRelativeToParent.AFTER
      ) {
        parentStep.nextAction = createAction(request.action, {
          nextAction: parentStep.nextAction,
          children,
        });
      } else {
        throw new ActivepiecesError(
          {
            code: ErrorCode.FLOW_OPERATION_INVALID,
            params: {},
          },
          `Loop step parent ${request.stepLocationRelativeToParent} not found`
        );
      }
    } else if (
      parentStep.type === ActionType.BRANCH &&
      request.stepLocationRelativeToParent
    ) {
      if (
        request.stepLocationRelativeToParent ===
        StepLocationRelativeToParent.INSIDE_TRUE_BRANCH
      ) {
        parentStep.onSuccessAction = createAction(request.action, {
          nextAction: parentStep.onSuccessAction,
          children,
        });
      } else if (
        request.stepLocationRelativeToParent ===
        StepLocationRelativeToParent.INSIDE_FALSE_BRANCH
      ) {
        parentStep.onFailureAction = createAction(request.action, {
          nextAction: parentStep.onFailureAction,
          children,
        });
      } else if (
        request.stepLocationRelativeToParent ===
        StepLocationRelativeToParent.AFTER
      ) {
        parentStep.nextAction = createAction(request.action, {
          nextAction: parentStep.nextAction,
          children,
        });
      } else {
        throw new ActivepiecesError(
          {
            code: ErrorCode.FLOW_OPERATION_INVALID,
            params: {},
          },
          `Branch step parernt ${request.stepLocationRelativeToParent} not found`
        );
      }
    } else if (
      parentStep.type === ActionType.ROUTER &&
      request.stepLocationRelativeToParent
    ) {
      if (
        request.stepLocationRelativeToParent ===
          StepLocationRelativeToParent.INSIDE_BRANCH &&
        !isNil(request.branchIndex)
      ) {
        parentStep.children[request.branchIndex] = createAction(
          request.action,
          {
            nextAction: parentStep.children[request.branchIndex] ?? undefined,
            children,
          }
        );
      } else if (
        request.stepLocationRelativeToParent ===
        StepLocationRelativeToParent.AFTER
      ) {
        parentStep.nextAction = createAction(request.action, {
          nextAction: parentStep.nextAction,
          children,
        });
      } else {
        throw new ActivepiecesError(
          {
            code: ErrorCode.FLOW_OPERATION_INVALID,
            params: {},
          },
          `Branch step parernt ${request.stepLocationRelativeToParent} not found`
        );
      }
    } else {
      parentStep.nextAction = createAction(request.action, {
        nextAction: parentStep.nextAction,
        children,
      });
    }
    return parentStep;
  });
}

function createAction(
  request: UpdateActionRequest,
  {
    nextAction,
    onFailureAction,
    onSuccessAction,
    firstLoopAction,
    children,
  }: {
    nextAction?: Action;
    firstLoopAction?: Action;
    onSuccessAction?: Action;
    onFailureAction?: Action;
    children?: (Action | null)[];
  }
): Action {
  const baseProperties = {
    displayName: request.displayName,
    name: request.name,
    valid: false,
    nextAction,
  };
  let action: Action;
  switch (request.type) {
    case ActionType.BRANCH:
      action = {
        ...baseProperties,
        onFailureAction,
        onSuccessAction,
        type: ActionType.BRANCH,
        settings: request.settings,
      };
      break;
    case ActionType.ROUTER:
      action = {
        ...baseProperties,
        type: ActionType.ROUTER,
        settings: request.settings,
        children: children ?? [null, null],
      };

      break;
    case ActionType.LOOP_ON_ITEMS:
      action = {
        ...baseProperties,
        firstLoopAction,
        type: ActionType.LOOP_ON_ITEMS,
        settings: request.settings,
      };
      break;
    case ActionType.PIECE:
      action = {
        ...baseProperties,
        type: ActionType.PIECE,
        settings: request.settings,
      };
      break;
    case ActionType.CODE:
      action = {
        ...baseProperties,
        type: ActionType.CODE,
        settings: request.settings,
      };
      break;
  }
  return {
    ...action,
    valid:
      (isNil(request.valid) ? true : request.valid) &&
      actionSchemaValidator.Check(action),
  };
}

function isChildOf(
  parent: LoopOnItemsAction | BranchAction | RouterAction,
  childStepName: string
): boolean {
  switch (parent.type) {
    case ActionType.LOOP_ON_ITEMS: {
      const children = getAllChildSteps(parent);
      return children.findIndex((c) => c.name === childStepName) > -1;
    }
    case ActionType.ROUTER: {
      const children = parent.children.filter(
        (child): child is Action => child !== null
      );
      return children.findIndex((c) => c.name === childStepName) > -1;
    }
    default: {
      const children = getAllChildSteps(parent);
      return children.findIndex((c) => c.name === childStepName) > -1;
    }
  }
}
function createTrigger(
  name: string,
  request: UpdateTriggerRequest,
  nextAction: Action | undefined
): Trigger {
  const baseProperties = {
    displayName: request.displayName,
    name,
    valid: false,
    nextAction,
  };
  let trigger: Trigger;
  switch (request.type) {
    case TriggerType.EMPTY:
      trigger = {
        ...baseProperties,
        type: TriggerType.EMPTY,
        settings: request.settings,
      };
      break;
    case TriggerType.PIECE:
      trigger = {
        ...baseProperties,
        type: TriggerType.PIECE,
        settings: request.settings,
      };
      break;
  }
  return {
    ...trigger,
    valid:
      (isNil(request.valid) ? true : request.valid) &&
      triggerSchemaValidation.Check(trigger),
  };
}

export function getImportOperations(
  step: Action | Trigger | undefined
): FlowOperationRequest[] {
  const steps: FlowOperationRequest[] = [];
  while (step) {
    if (step.nextAction) {
      steps.push({
        type: FlowOperationType.ADD_ACTION,
        request: {
          parentStep: step?.name ?? '',
          action: removeAnySubsequentAction(step.nextAction),
        },
      });
    }
    switch (step.type) {
      case ActionType.BRANCH: {
        if (step.onFailureAction) {
          steps.push({
            type: FlowOperationType.ADD_ACTION,
            request: {
              parentStep: step?.name ?? '',
              stepLocationRelativeToParent:
                StepLocationRelativeToParent.INSIDE_FALSE_BRANCH,
              action: removeAnySubsequentAction(step.onFailureAction),
            },
          });
          steps.push(...getImportOperations(step.onFailureAction));
        }
        if (step.onSuccessAction) {
          steps.push({
            type: FlowOperationType.ADD_ACTION,
            request: {
              parentStep: step.name,
              stepLocationRelativeToParent:
                StepLocationRelativeToParent.INSIDE_TRUE_BRANCH,
              action: removeAnySubsequentAction(step.onSuccessAction),
            },
          });
          steps.push(...getImportOperations(step.onSuccessAction));
        }
        break;
      }
      case ActionType.LOOP_ON_ITEMS: {
        if (step.firstLoopAction) {
          steps.push({
            type: FlowOperationType.ADD_ACTION,
            request: {
              parentStep: step.name,
              stepLocationRelativeToParent:
                StepLocationRelativeToParent.INSIDE_LOOP,
              action: removeAnySubsequentAction(step.firstLoopAction),
            },
          });
          steps.push(...getImportOperations(step.firstLoopAction));
        }
        break;
      }
      case ActionType.ROUTER: {
        if (step.children) {
          step.children.forEach((child, index) => {
            if (!isNil(child) && !isNil(step?.name)) {
              steps.push({
                type: FlowOperationType.ADD_ACTION,
                request: {
                  parentStep: step.name,
                  stepLocationRelativeToParent:
                    StepLocationRelativeToParent.INSIDE_BRANCH,
                  branchIndex: index,
                  branchName: 'Branch ' + index,
                  action: removeAnySubsequentAction(child),
                },
              });
              steps.push(...getImportOperations(child));
            }
          });
        }
        break;
      }
      case ActionType.CODE:
      case ActionType.PIECE:
      case TriggerType.PIECE:
      case TriggerType.EMPTY: {
        break;
      }
    }

    step = step.nextAction;
  }
  return steps;
}

function removeAnySubsequentAction(action: Action): Action {
  const clonedAction: Action = JSON.parse(JSON.stringify(action));
  switch (clonedAction.type) {
    case ActionType.BRANCH: {
      delete clonedAction.onSuccessAction;
      delete clonedAction.onFailureAction;
      break;
    }
    case ActionType.ROUTER: {
      clonedAction.children = clonedAction.children.map((child) => {
        if (isNil(child)) {
          return null;
        }
        return removeAnySubsequentAction(child);
      });
      break;
    }
    case ActionType.LOOP_ON_ITEMS: {
      delete clonedAction.firstLoopAction;
      break;
    }
    case ActionType.PIECE:
    case ActionType.CODE:
      break;
  }
  delete clonedAction.nextAction;
  return clonedAction;
}

function normalize(flowVersion: FlowVersion): FlowVersion {
  return transferFlow(flowVersion, (step) => {
    const clonedStep: Step = JSON.parse(JSON.stringify(step));
    clonedStep.settings.inputUiInfo = DEFAULT_SAMPLE_DATA_SETTINGS;
    if (
      clonedStep?.settings?.input?.auth &&
      [ActionType.PIECE, TriggerType.PIECE].includes(step.type)
    ) {
      clonedStep.settings.input.auth = '';
    }
    return upgradePiece(clonedStep, clonedStep.name);
  });
}

function upgradePiece(step: Step, stepName: string): Step {
  if (step.name !== stepName) {
    return step;
  }
  const clonedStep: Step = JSON.parse(JSON.stringify(step));
  switch (step.type) {
    case ActionType.PIECE:
    case TriggerType.PIECE: {
      const { pieceVersion, pieceName } = step.settings;
      if (isLegacyApp({ pieceName, pieceVersion })) {
        return step;
      }
      if (pieceVersion.startsWith('^') || pieceVersion.startsWith('~')) {
        return step;
      }
      if (semver.valid(pieceVersion) && semver.lt(pieceVersion, '1.0.0')) {
        clonedStep.settings.pieceVersion = `~${pieceVersion}`;
      } else {
        clonedStep.settings.pieceVersion = `^${pieceVersion}`;
      }
      break;
    }
    default:
      break;
  }
  return clonedStep;
}

// TODO Remove this in 2024, these pieces didn't follow the standard versioning where the minor version has to be increased when there is breaking change.
function isLegacyApp({
  pieceName,
  pieceVersion,
}: {
  pieceName: string;
  pieceVersion: string;
}) {
  let newVersion = pieceVersion;
  if (newVersion.startsWith('^') || newVersion.startsWith('~')) {
    newVersion = newVersion.substring(1);
  }
  if (
    pieceName === '@activepieces/piece-google-sheets' &&
    semver.lt(newVersion, '0.3.0')
  ) {
    return true;
  }
  if (
    pieceName === '@activepieces/piece-gmail' &&
    semver.lt(newVersion, '0.3.0')
  ) {
    return true;
  }
  return false;
}

function isPartOfInnerFlow({
  parentStep,
  childName,
}: {
  parentStep: Action | Trigger;
  childName: string;
}): boolean {
  const steps = getAllSteps({
    ...parentStep,
    nextAction: undefined,
  });
  return steps.some((step) => step.name === childName);
}

function duplicateStep(
  stepName: string,
  flowVersionWithArtifacts: FlowVersion
): FlowVersion {
  const clonedStep = JSON.parse(
    JSON.stringify(flowHelper.getStep(flowVersionWithArtifacts, stepName))
  );
  clonedStep.nextAction = undefined;
  if (!clonedStep) {
    throw new Error(`step with name '${stepName}' not found`);
  }
  const existingNames = getAllSteps(flowVersionWithArtifacts.trigger).map(
    (step) => step.name
  );
  const oldStepsNameToReplace = getAllSteps(clonedStep).map(
    (step) => step.name
  );
  const oldNameToNewName: Record<string, string> = {};

  oldStepsNameToReplace.forEach((name) => {
    const newName = findUnusedName(existingNames, 'step');
    oldNameToNewName[name] = newName;
    existingNames.push(newName);
  });

  const duplicatedStep = transferStep(clonedStep, (step: Step) => {
    step.displayName = `${step.displayName} Copy`;
    step.name = oldNameToNewName[step.name];
    if (step.settings.inputUiInfo) {
      step.settings.inputUiInfo.currentSelectedData = undefined;
      step.settings.inputUiInfo.sampleDataFileId = undefined;
      step.settings.inputUiInfo.lastTestDate = undefined;
    }
    oldStepsNameToReplace.forEach((oldName) => {
      step.settings.input = applyFunctionToValuesSync(
        step.settings.input,
        (value: unknown) => {
          if (isString(value)) {
            return replaceOldStepNameWithNewOne({
              input: value,
              oldStepName: oldName,
              newStepName: oldNameToNewName[oldName],
            });
          }
          return value;
        }
      );
    });
    return step;
  });
  let finalFlow = addAction(
    flowVersionWithArtifacts,
    {
      action: duplicatedStep as Action,
      parentStep: stepName,
      stepLocationRelativeToParent: StepLocationRelativeToParent.AFTER,
    },
    duplicatedStep.type === ActionType.ROUTER
      ? duplicatedStep.children.map(() => null)
      : undefined
  );

  const operations = getImportOperations(duplicatedStep);
  operations.forEach((operation) => {
    finalFlow = flowHelper.apply(finalFlow, operation);
  });
  return finalFlow;
}

function duplicateRouterChild(
  routerName: string,
  childIndex: number,
  flowVersionWithArtifacts: FlowVersion
): FlowVersion {
  const routerStep = flowHelper.getStep(
    flowVersionWithArtifacts,
    routerName
  ) as RouterAction | undefined;

  if (!routerStep) {
    throw new Error(`step with name '${routerName}' not found`);
  }

  const existingNames = getAllSteps(flowVersionWithArtifacts.trigger).map(
    (step) => step.name
  );

  const clonedChildStep = JSON.parse(
    JSON.stringify(routerStep.children[childIndex])
  );
  const duplicatedBranch = JSON.parse(
    JSON.stringify(routerStep.settings.branches[childIndex])
  ) as RouterAction['settings']['branches'][number];
  duplicatedBranch.branchName = `${duplicatedBranch.branchName} Copy`;
  routerStep.settings.branches.splice(-1, 0, duplicatedBranch);
  routerStep.children.splice(-1, 0, null);
  if (isNil(clonedChildStep)) {
    return flowVersionWithArtifacts;
  }

  const oldStepsNameToReplace = getAllSteps(clonedChildStep).map(
    (step) => step.name
  );
  const oldNameToNewName: Record<string, string> = {};

  oldStepsNameToReplace.forEach((name) => {
    const newName = findUnusedName(existingNames, 'step');
    oldNameToNewName[name] = newName;
    existingNames.push(newName);
  });

  const duplicatedStep = transferStep(clonedChildStep, (step: Step) => {
    step.displayName = `${step.displayName} Copy`;
    step.name = oldNameToNewName[step.name];
    if (step.settings.inputUiInfo) {
      step.settings.inputUiInfo.currentSelectedData = undefined;
      step.settings.inputUiInfo.sampleDataFileId = undefined;
      step.settings.inputUiInfo.lastTestDate = undefined;
    }
    oldStepsNameToReplace.forEach((oldName) => {
      step.settings.input = applyFunctionToValuesSync(
        step.settings.input,
        (value: unknown) => {
          if (isString(value)) {
            return replaceOldStepNameWithNewOne({
              input: value,
              oldStepName: oldName,
              newStepName: oldNameToNewName[oldName],
            });
          }
          return value;
        }
      );
    });
    return step;
  });

  let finalFlow = addAction(flowVersionWithArtifacts, {
    action: duplicatedStep as Action,
    parentStep: routerName,
    stepLocationRelativeToParent: StepLocationRelativeToParent.INSIDE_BRANCH,
    branchIndex: routerStep.children.length - 2,
  });
  const operations = getImportOperations(duplicatedStep);
  operations.forEach((operation) => {
    finalFlow = flowHelper.apply(finalFlow, operation);
  });
  return finalFlow;
}

function replaceOldStepNameWithNewOne({
  input,
  oldStepName,
  newStepName,
}: {
  input: string;
  oldStepName: string;
  newStepName: string;
}): string {
  const regex = /{{(.*?)}}/g; // Regular expression to match strings inside {{ }}
  return input.replace(regex, (match, content) => {
    // Replace the content inside {{ }} using the provided function
    const replacedContent = content.replaceAll(
      new RegExp(`\\b${oldStepName}\\b`, 'g'),
      `${newStepName}`
    );

    // Reconstruct the {{ }} with the replaced content
    return `{{${replacedContent}}}`;
  });
}

function doesActionHaveChildren(
  action: Action | Trigger
): action is LoopOnItemsAction | BranchAction {
  if (
    action.type === ActionType.BRANCH ||
    action.type === ActionType.LOOP_ON_ITEMS
  ) {
    return true;
  }
  return false;
}

function findUnusedName(names: string[], stepPrefix: string): string {
  let availableNumber = 1;
  let availableName = `${stepPrefix}_${availableNumber}`;

  while (names.includes(availableName)) {
    availableNumber++;
    availableName = `${stepPrefix}_${availableNumber}`;
  }

  return availableName;
}

function findAvailableStepName(
  flowVersion: FlowVersion,
  stepPrefix: string
): string {
  const steps = flowHelper.getAllSteps(flowVersion.trigger).map((f) => f.name);
  return findUnusedName(steps, stepPrefix);
}

function getDirectParentStep(
  child: Step,
  parent: Trigger | Step | RouterAction | undefined
): Step | Trigger | RouterAction | undefined {
  if (!parent) {
    return undefined;
  }
  if (isTrigger(parent.type)) {
    let next = parent.nextAction;
    while (next) {
      if (next.name === child.name) {
        return parent;
      }
      next = next.nextAction;
    }
  }

  if (parent.type === ActionType.BRANCH) {
    const isChildOfBranch = isChildOf(parent, child.name);
    if (isChildOfBranch) {
      const directTrueBranchChildren = getAllDirectChildStepsForBranch(
        parent,
        'success'
      );
      const directFalseBranchChildren = getAllDirectChildStepsForBranch(
        parent,
        'failure'
      );
      if (
        directTrueBranchChildren.at(-1)?.name === child.name ||
        directFalseBranchChildren.at(-1)?.name === child.name
      ) {
        return parent;
      }

      return (
        getDirectParentStep(child, parent.onSuccessAction) ??
        getDirectParentStep(child, parent.onFailureAction)
      );
    }
  }
  if (parent.type === ActionType.LOOP_ON_ITEMS) {
    const isChildOfLoop = isChildOf(parent, child.name);
    if (isChildOfLoop) {
      const directChildren = getAllDirectChildStepsForLoop(parent);
      if (directChildren.at(-1)?.name === child.name) {
        return parent;
      }
      return getDirectParentStep(child, parent.firstLoopAction);
    }
  }
  if (parent.type === ActionType.ROUTER) {
    const isChildOfRouter = isChildOf(parent as RouterAction, child.name);
    if (isChildOfRouter) {
      const directChildren = parent.children
        .map((child) => child?.nextAction)
        .filter((child) => child);
      if (directChildren.at(-1)?.name === child.name) {
        return parent;
      }
      return getDirectParentStep(child, parent.children[0]?.nextAction);
    }
  }
  return getDirectParentStep(child, parent.nextAction);
}

// TODO remove this function after deprecation angular
function isStepLastChildOfParent(child: Step, trigger: Trigger): boolean {
  const parent = getDirectParentStep(child, trigger);
  if (parent) {
    if (doesStepHaveChildren(parent)) {
      if (parent.type === ActionType.LOOP_ON_ITEMS) {
        const children = getAllDirectChildStepsForLoop(parent);
        return children[children.length - 1]?.name === child.name;
      }
      if (parent.type === ActionType.ROUTER) {
        const children = parent.children
          .map((child) => child?.nextAction)
          .filter((child) => child);
        return children[children.length - 1]?.name === child.name;
      }
      const trueBranchChildren = getAllDirectChildStepsForBranch(
        parent,
        'success'
      );
      const falseBranchChildren = getAllDirectChildStepsForBranch(
        parent,
        'failure'
      );
      return (
        trueBranchChildren[trueBranchChildren.length - 1]?.name ===
          child.name ||
        falseBranchChildren[falseBranchChildren.length - 1]?.name === child.name
      );
    }
    let next = parent.nextAction;
    while (next) {
      if (next.nextAction === undefined && next.name === child.name) {
        return true;
      }
      next = next.nextAction;
    }
  }

  return false;
}

function doesStepHaveChildren(
  step: Step
): step is LoopOnItemsAction | BranchAction | RouterAction {
  return (
    step.type === ActionType.BRANCH ||
    step.type === ActionType.LOOP_ON_ITEMS ||
    step.type === ActionType.ROUTER
  );
}

type StepWithIndex = Step & { dfsIndex: number };

function findPathToStep({
  targetStepName,
  trigger,
}: {
  targetStepName: string;
  trigger: Trigger;
}): StepWithIndex[] {
  const steps = getAllSteps(trigger).map((step, dfsIndex) => ({
    ...step,
    dfsIndex,
  }));
  return steps
    .filter((step) => {
      const steps = getAllSteps(step);
      return steps.some((s) => s.name === targetStepName);
    })
    .filter((step) => step.name !== targetStepName);
}
const createEmptyBranch = (pathNumber: number) => {
  return {
    conditions: [[emptyCondition]],
    branchType: BranchExecutionType.CONDITION,
    branchName: `Branch ${pathNumber}`,
  };
};

export const flowHelper = {
  isValid,
  apply(
    flowVersion: FlowVersion,
    operation: FlowOperationRequest
  ): FlowVersion {
    let clonedVersion: FlowVersion = JSON.parse(JSON.stringify(flowVersion));
    switch (operation.type) {
      case FlowOperationType.MOVE_ACTION:
        console.log('operation.request move', operation.request);
        clonedVersion = moveAction(clonedVersion, operation.request);
        break;
      case FlowOperationType.LOCK_FLOW:
        clonedVersion.state = FlowVersionState.LOCKED;
        break;
      case FlowOperationType.CHANGE_NAME:
        clonedVersion.displayName = operation.request.displayName;
        break;
      case FlowOperationType.DELETE_ACTION:
        clonedVersion = deleteAction(clonedVersion, operation.request);
        break;
      case FlowOperationType.ADD_ACTION: {
        clonedVersion = transferFlow(
          addAction(clonedVersion, operation.request),
          (step) => upgradePiece(step, operation.request.action.name)
        );
        break;
      }
      case FlowOperationType.UPDATE_ACTION:
        clonedVersion = transferFlow(
          updateAction(clonedVersion, operation.request),
          (step) => upgradePiece(step, operation.request.name)
        );
        break;

      case FlowOperationType.UPDATE_TRIGGER:
        clonedVersion.trigger = createTrigger(
          clonedVersion.trigger.name,
          operation.request,
          clonedVersion.trigger.nextAction
        );
        clonedVersion = transferFlow(clonedVersion, (step) =>
          upgradePiece(step, operation.request.name)
        );
        break;
      case FlowOperationType.DUPLICATE_ACTION: {
        clonedVersion = duplicateStep(
          operation.request.stepName,
          clonedVersion
        );
        break;
      }
      case FlowOperationType.DELETE_BRANCH: {
        clonedVersion = transferFlow(flowVersion, (parentStep) => {
          if (
            parentStep.nextAction?.name === operation.request.stepName &&
            parentStep.nextAction?.type === ActionType.ROUTER
          ) {
            (parentStep.nextAction as RouterAction).settings.branches.splice(
              operation.request.branchIndex,
              1
            );
            (parentStep.nextAction as RouterAction).children.splice(
              operation.request.branchIndex,
              1
            );
          }
          return parentStep;
        });
        break;
      }
      case FlowOperationType.ADD_BRANCH: {
        clonedVersion = transferFlow(flowVersion, (parentStep) => {
          if (
            parentStep.nextAction?.name === operation.request.stepName &&
            parentStep.nextAction?.type === ActionType.ROUTER
          ) {
            (parentStep.nextAction as RouterAction).settings.branches.splice(
              operation.request.branchIndex,
              0,
              createEmptyBranch(
                (parentStep.nextAction as RouterAction).settings.branches.length
              )
            );
            (parentStep.nextAction as RouterAction).children.splice(
              operation.request.branchIndex,
              0,
              null
            );
          }
          return parentStep;
        });
        break;
      }
      case FlowOperationType.DUPLICATE_BRANCH: {
        clonedVersion = duplicateRouterChild(
          operation.request.stepName,
          operation.request.branchIndex,
          clonedVersion
        );
        break;
      }
      default:
        break;
    }
    clonedVersion.valid = isValid(clonedVersion);
    return clonedVersion;
  },

  getStep,
  isAction,
  isTrigger,
  getAllSteps,
  isPartOfInnerFlow,
  isStepLastChildOfParent,
  getUsedPieces,
  getImportOperations,
  normalize,
  getStepFromSubFlow,
  isChildOf,
  transferFlowAsync,
  getAllChildSteps,
  getAllStepsAtFirstLevel,
  duplicateStep,
  findAvailableStepName,
  doesActionHaveChildren,
  findPathToStep,
  updateFlowSecrets,
  findUnusedName,
  createEmptyPath: createEmptyBranch,
};
