/** Bump when an older editor can no longer round-trip the canonical document safely. */
export const EDITOR_CONTRACT = 'lanka-editor/3';
export const EDITOR_UPGRADE_MESSAGE = 'Редактор в этой вкладке устарел. Сохранение остановлено, чтобы не потерять оформление. Скачайте «Мои правки», затем откройте презентацию в новой вкладке. Не закрывайте текущую вкладку до переноса правок.';
export class EditorUpgradeError extends Error { constructor(){super(EDITOR_UPGRADE_MESSAGE);} }
export function assertEditorContract(value:unknown){
 if(value!==EDITOR_CONTRACT)throw new EditorUpgradeError();
}
/** HTTP full-document saves must identify the editor that produced their bytes. */
export function checkEditorWrite(input:unknown){
 const value=input as {command?:{action?:unknown;editorContract?:unknown}}|null;
 if(value?.command?.action==='save')assertEditorContract(value.command.editorContract);
}
