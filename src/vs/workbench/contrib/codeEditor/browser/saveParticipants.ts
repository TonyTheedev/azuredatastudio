/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from 'vs/base/common/cancellation';
import * as strings from 'vs/base/common/strings';
import { IActiveCodeEditor } from 'vs/editor/browser/editorBrowser';
import { ICodeEditorService } from 'vs/editor/browser/services/codeEditorService';
import { trimTrailingWhitespace } from 'vs/editor/common/commands/trimTrailingWhitespaceCommand';
import { EditOperation } from 'vs/editor/common/core/editOperation';
import { Position } from 'vs/editor/common/core/position';
import { Range } from 'vs/editor/common/core/range';
import { Selection } from 'vs/editor/common/core/selection';
import { ITextModel } from 'vs/editor/common/model';
import { CodeActionTriggerType, DocumentFormattingEditProvider, CodeActionProvider } from 'vs/editor/common/modes';
import { getCodeActions } from 'vs/editor/contrib/codeAction/codeAction';
import { applyCodeAction } from 'vs/editor/contrib/codeAction/codeActionCommands';
import { CodeActionKind } from 'vs/editor/contrib/codeAction/types';
import { formatDocumentWithSelectedProvider, FormattingMode } from 'vs/editor/contrib/format/format';
import { SnippetController2 } from 'vs/editor/contrib/snippet/snippetController2';
import { localize } from 'vs/nls';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IProgressStep, IProgress, Progress } from 'vs/platform/progress/common/progress';
import { IResolvedTextFileEditorModel, ITextFileService, ITextFileSaveParticipant } from 'vs/workbench/services/textfile/common/textfiles';
import { SaveReason } from 'vs/workbench/common/editor';
import { Disposable } from 'vs/base/common/lifecycle';
import { IWorkbenchContribution, Extensions as WorkbenchContributionsExtensions, IWorkbenchContributionsRegistry } from 'vs/workbench/common/contributions';
import { Registry } from 'vs/platform/registry/common/platform';
import { LifecyclePhase } from 'vs/platform/lifecycle/common/lifecycle';
import { INotebookService } from 'sql/workbench/services/notebook/browser/notebookService';

/*
 * An update participant that ensures any un-tracked changes are synced to the JSON file contents for a
 * Notebook before save occurs. While every effort is made to ensure model changes are notified and a listener
 * updates the backing model in-place, this is a backup mechanism to hard-update the file before save in case
 * some are missed.
 */
class NotebookUpdateParticipant implements ITextFileSaveParticipant { // {{SQL CARBON EDIT}} add notebook participant

	constructor(
		@INotebookService private notebookService: INotebookService
	) {
		// Nothing
	}

	public participate(model: IResolvedTextFileEditorModel, env: { reason: SaveReason }): Promise<void> {
		let uri = model.resource;
		let notebookEditor = this.notebookService.findNotebookEditor(uri);
		if (notebookEditor) {
			notebookEditor.notebookParams.input.updateModel();
		}
		return Promise.resolve();
	}
}

export class TrimWhitespaceParticipant implements ITextFileSaveParticipant {

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService
	) {
		// Nothing
	}

	async participate(model: IResolvedTextFileEditorModel, env: { reason: SaveReason; }): Promise<void> {
		if (this.configurationService.getValue('files.trimTrailingWhitespace', { overrideIdentifier: model.textEditorModel.getLanguageIdentifier().language, resource: model.resource })) {
			this.doTrimTrailingWhitespace(model.textEditorModel, env.reason === SaveReason.AUTO);
		}
	}

	private doTrimTrailingWhitespace(model: ITextModel, isAutoSaved: boolean): void {
		let prevSelection: Selection[] = [];
		let cursors: Position[] = [];

		const editor = findEditor(model, this.codeEditorService);
		if (editor) {
			// Find `prevSelection` in any case do ensure a good undo stack when pushing the edit
			// Collect active cursors in `cursors` only if `isAutoSaved` to avoid having the cursors jump
			prevSelection = editor.getSelections();
			if (isAutoSaved) {
				cursors = prevSelection.map(s => s.getPosition());
				const snippetsRange = SnippetController2.get(editor).getSessionEnclosingRange();
				if (snippetsRange) {
					for (let lineNumber = snippetsRange.startLineNumber; lineNumber <= snippetsRange.endLineNumber; lineNumber++) {
						cursors.push(new Position(lineNumber, model.getLineMaxColumn(lineNumber)));
					}
				}
			}
		}

		const ops = trimTrailingWhitespace(model, cursors);
		if (!ops.length) {
			return; // Nothing to do
		}

		model.pushEditOperations(prevSelection, ops, (_edits) => prevSelection);
	}
}

function findEditor(model: ITextModel, codeEditorService: ICodeEditorService): IActiveCodeEditor | null {
	let candidate: IActiveCodeEditor | null = null;

	if (model.isAttachedToEditor()) {
		for (const editor of codeEditorService.listCodeEditors()) {
			if (editor.hasModel() && editor.getModel() === model) {
				if (editor.hasTextFocus()) {
					return editor; // favour focused editor if there are multiple
				}

				candidate = editor;
			}
		}
	}

	return candidate;
}

export class FinalNewLineParticipant implements ITextFileSaveParticipant {

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService
	) {
		// Nothing
	}

	async participate(model: IResolvedTextFileEditorModel, _env: { reason: SaveReason; }): Promise<void> {
		if (this.configurationService.getValue('files.insertFinalNewline', { overrideIdentifier: model.textEditorModel.getLanguageIdentifier().language, resource: model.resource })) {
			this.doInsertFinalNewLine(model.textEditorModel);
		}
	}

	private doInsertFinalNewLine(model: ITextModel): void {
		const lineCount = model.getLineCount();
		const lastLine = model.getLineContent(lineCount);
		const lastLineIsEmptyOrWhitespace = strings.lastNonWhitespaceIndex(lastLine) === -1;

		if (!lineCount || lastLineIsEmptyOrWhitespace) {
			return;
		}

		const edits = [EditOperation.insert(new Position(lineCount, model.getLineMaxColumn(lineCount)), model.getEOL())];
		const editor = findEditor(model, this.codeEditorService);
		if (editor) {
			editor.executeEdits('insertFinalNewLine', edits, editor.getSelections());
		} else {
			model.pushEditOperations([], edits, () => null);
		}
	}
}

export class TrimFinalNewLinesParticipant implements ITextFileSaveParticipant {

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService
	) {
		// Nothing
	}

	async participate(model: IResolvedTextFileEditorModel, env: { reason: SaveReason; }): Promise<void> {
		if (this.configurationService.getValue('files.trimFinalNewlines', { overrideIdentifier: model.textEditorModel.getLanguageIdentifier().language, resource: model.resource })) {
			this.doTrimFinalNewLines(model.textEditorModel, env.reason === SaveReason.AUTO);
		}
	}

	/**
	 * returns 0 if the entire file is empty or whitespace only
	 */
	private findLastLineWithContent(model: ITextModel): number {
		for (let lineNumber = model.getLineCount(); lineNumber >= 1; lineNumber--) {
			const lineContent = model.getLineContent(lineNumber);
			if (strings.lastNonWhitespaceIndex(lineContent) !== -1) {
				// this line has content
				return lineNumber;
			}
		}
		// no line has content
		return 0;
	}

	private doTrimFinalNewLines(model: ITextModel, isAutoSaved: boolean): void {
		const lineCount = model.getLineCount();

		// Do not insert new line if file does not end with new line
		if (lineCount === 1) {
			return;
		}

		let prevSelection: Selection[] = [];
		let cannotTouchLineNumber = 0;
		const editor = findEditor(model, this.codeEditorService);
		if (editor) {
			prevSelection = editor.getSelections();
			if (isAutoSaved) {
				for (let i = 0, len = prevSelection.length; i < len; i++) {
					const positionLineNumber = prevSelection[i].positionLineNumber;
					if (positionLineNumber > cannotTouchLineNumber) {
						cannotTouchLineNumber = positionLineNumber;
					}
				}
			}
		}

		const lastLineNumberWithContent = this.findLastLineWithContent(model);
		const deleteFromLineNumber = Math.max(lastLineNumberWithContent + 1, cannotTouchLineNumber + 1);
		const deletionRange = model.validateRange(new Range(deleteFromLineNumber, 1, lineCount, model.getLineMaxColumn(lineCount)));

		if (deletionRange.isEmpty()) {
			return;
		}

		model.pushEditOperations(prevSelection, [EditOperation.delete(deletionRange)], _edits => prevSelection);

		if (editor) {
			editor.setSelections(prevSelection);
		}
	}
}

class FormatOnSaveParticipant implements ITextFileSaveParticipant {

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICodeEditorService private readonly codeEditorService: ICodeEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		// Nothing
	}

	async participate(editorModel: IResolvedTextFileEditorModel, env: { reason: SaveReason; }, progress: IProgress<IProgressStep>, token: CancellationToken): Promise<void> {
		const model = editorModel.textEditorModel;
		const overrides = { overrideIdentifier: model.getLanguageIdentifier().language, resource: model.uri };

		if (env.reason === SaveReason.AUTO || !this.configurationService.getValue('editor.formatOnSave', overrides)) {
			return undefined;
		}

		const nestedProgress = new Progress<DocumentFormattingEditProvider>(provider => {
			progress.report({
				message: localize(
					'formatting',
					"Running '{0}' Formatter ([configure](command:workbench.action.openSettings?%5B%22editor.formatOnSave%22%5D)).",
					provider.displayName || provider.extensionId && provider.extensionId.value || '???'
				)
			});
		});
		const editorOrModel = findEditor(model, this.codeEditorService) || model;
		await this.instantiationService.invokeFunction(formatDocumentWithSelectedProvider, editorOrModel, FormattingMode.Silent, nestedProgress, token);
	}
}

class CodeActionOnSaveParticipant implements ITextFileSaveParticipant {

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) { }

	async participate(editorModel: IResolvedTextFileEditorModel, env: { reason: SaveReason; }, progress: IProgress<IProgressStep>, token: CancellationToken): Promise<void> {
		if (env.reason === SaveReason.AUTO) {
			return undefined;
		}
		const model = editorModel.textEditorModel;

		const settingsOverrides = { overrideIdentifier: model.getLanguageIdentifier().language, resource: editorModel.resource };
		const setting = this.configurationService.getValue<{ [kind: string]: boolean } | string[]>('editor.codeActionsOnSave', settingsOverrides);
		if (!setting) {
			return undefined;
		}

		const settingItems: string[] = Array.isArray(setting)
			? setting
			: Object.keys(setting).filter(x => setting[x]);

		const codeActionsOnSave = settingItems
			.map(x => new CodeActionKind(x));

		if (!Array.isArray(setting)) {
			codeActionsOnSave.sort((a, b) => {
				if (CodeActionKind.SourceFixAll.contains(a)) {
					if (CodeActionKind.SourceFixAll.contains(b)) {
						return 0;
					}
					return -1;
				}
				if (CodeActionKind.SourceFixAll.contains(b)) {
					return 1;
				}
				return 0;
			});
		}

		if (!codeActionsOnSave.length) {
			return undefined;
		}

		const excludedActions = Array.isArray(setting)
			? []
			: Object.keys(setting)
				.filter(x => setting[x] === false)
				.map(x => new CodeActionKind(x));

		progress.report({ message: localize('codeaction', "Quick Fixes") });
		await this.applyOnSaveActions(model, codeActionsOnSave, excludedActions, progress, token);
	}

	private async applyOnSaveActions(model: ITextModel, codeActionsOnSave: readonly CodeActionKind[], excludes: readonly CodeActionKind[], progress: IProgress<IProgressStep>, token: CancellationToken): Promise<void> {

		const getActionProgress = new class implements IProgress<CodeActionProvider> {
			private _names: string[] = [];
			private _report(): void {
				progress.report({
					message: localize(
						'codeaction.get',
						"Getting code actions from '{0}' ([configure](command:workbench.action.openSettings?%5B%22editor.codeActionsOnSave%22%5D)).",
						this._names.map(name => `'${name}'`).join(', ')
					)
				});
			}
			report(provider: CodeActionProvider) {
				if (provider.displayName) {
					this._names.push(provider.displayName);
					this._report();
				}
			}
		};

		for (const codeActionKind of codeActionsOnSave) {
			const actionsToRun = await this.getActionsToRun(model, codeActionKind, excludes, getActionProgress, token);
			try {
				for (const action of actionsToRun.validActions) {
					progress.report({ message: localize('codeAction.apply', "Applying code action '{0}'.", action.title) });
					await this.instantiationService.invokeFunction(applyCodeAction, action);
				}
			} catch {
				// Failure to apply a code action should not block other on save actions
			} finally {
				actionsToRun.dispose();
			}
		}
	}

	private getActionsToRun(model: ITextModel, codeActionKind: CodeActionKind, excludes: readonly CodeActionKind[], progress: IProgress<CodeActionProvider>, token: CancellationToken) {
		return getCodeActions(model, model.getFullModelRange(), {
			type: CodeActionTriggerType.Auto,
			filter: { include: codeActionKind, excludes: excludes, includeSourceActions: true },
		}, progress, token);
	}
}

export class SaveParticipantsContribution extends Disposable implements IWorkbenchContribution {

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITextFileService private readonly textFileService: ITextFileService
	) {
		super();

		this.registerSaveParticipants();
	}

	private registerSaveParticipants(): void {
		this._register(this.textFileService.files.addSaveParticipant(this.instantiationService.createInstance(TrimWhitespaceParticipant)));
		this._register(this.textFileService.files.addSaveParticipant(this.instantiationService.createInstance(CodeActionOnSaveParticipant)));
		this._register(this.textFileService.files.addSaveParticipant(this.instantiationService.createInstance(FormatOnSaveParticipant)));
		this._register(this.textFileService.files.addSaveParticipant(this.instantiationService.createInstance(FinalNewLineParticipant)));
		this._register(this.textFileService.files.addSaveParticipant(this.instantiationService.createInstance(TrimFinalNewLinesParticipant)));
		this._register(this.textFileService.files.addSaveParticipant(this.instantiationService.createInstance(NotebookUpdateParticipant)));
	}
}

const workbenchContributionsRegistry = Registry.as<IWorkbenchContributionsRegistry>(WorkbenchContributionsExtensions.Workbench);
workbenchContributionsRegistry.registerWorkbenchContribution(SaveParticipantsContribution, LifecyclePhase.Restored);
