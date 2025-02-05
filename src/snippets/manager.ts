import { Disposable, InsertTextMode, Range } from 'vscode-languageserver-protocol'
import events from '../events'
import { StatusBarItem } from '../model/status'
import { UltiSnippetOption } from '../types'
import { deepClone } from '../util/object'
import { emptyRange, rangeInRange } from '../util/position'
import window from '../window'
import workspace from '../workspace'
import { UltiSnippetContext } from './eval'
import { SnippetSession } from './session'
import { normalizeSnippetString, shouldFormat } from './snippet'
import { SnippetString } from './string'
const logger = require('../util/logger')('snippets-manager')

export class SnippetManager {
  private sessionMap: Map<number, SnippetSession> = new Map()
  private disposables: Disposable[] = []
  private statusItem: StatusBarItem
  private highlight: boolean
  private preferComplete: boolean

  constructor() {
    events.on(['TextChanged', 'TextChangedI'], bufnr => {
      let session = this.getSession(bufnr as number)
      if (session) session.sychronize()
    }, null, this.disposables)
    events.on(['MenuPopupChanged', 'InsertCharPre'], () => {
      // avoid update session when pumvisible
      // Update may cause completion unexpcted terminated.
      this.session?.cancel()
    }, null, this.disposables)
    events.on('BufUnload', bufnr => {
      let session = this.getSession(bufnr)
      if (session) session.deactivate()
    }, null, this.disposables)
    window.onDidChangeActiveTextEditor(e => {
      if (!this.statusItem) return
      let session = this.getSession(e.document.bufnr)
      if (session) {
        this.statusItem.show()
      } else {
        this.statusItem.hide()
      }
    }, null, this.disposables)
    events.on('InsertEnter', async bufnr => {
      let session = this.getSession(bufnr)
      if (session) await session.checkPosition()
    }, null, this.disposables)
    workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('suggest') || e.affectsConfiguration('coc.preferences')) {
        this.init()
      }
    }, null, this.disposables)
  }

  public init(): void {
    if (!this.statusItem) this.statusItem = window.createStatusBarItem(0)
    let config = workspace.getConfiguration('coc.preferences')
    this.statusItem.text = config.get<string>('snippetStatusText', 'SNIP')
    this.highlight = config.get<boolean>('snippetHighlight', false)
    let suggest = workspace.getConfiguration('suggest')
    this.preferComplete = suggest.get('preferCompleteThanJumpPlaceholder', false)
  }

  /**
   * Insert snippet at current cursor position
   */
  public async insertSnippet(snippet: string | SnippetString, select = true, range?: Range, insertTextMode?: InsertTextMode, ultisnip?: UltiSnippetOption): Promise<boolean> {
    let { bufnr } = workspace
    let doc = workspace.getDocument(bufnr)
    if (!doc || !doc.attached) {
      throw new Error(`Unable to insert snippet, buffer ${bufnr} not attached.`)
    }
    if (range && !rangeInRange(range, Range.create(0, 0, doc.lineCount + 1, 0))) {
      throw new Error(`Unable to insert snippet, invalid range.`)
    }
    let context: UltiSnippetContext
    if (!range) {
      let pos = await window.getCursorPosition()
      range = Range.create(pos, pos)
    }
    const currentLine = doc.getline(range.start.line)
    const snippetStr = SnippetString.isSnippetString(snippet) ? snippet.value : snippet
    const inserted = await this.normalizeInsertText(doc.uri, snippetStr, currentLine, insertTextMode)
    let session = this.getSession(bufnr)
    if (session) session.cancel()
    if (ultisnip != null) {
      context = Object.assign({ range: deepClone(range), line: currentLine }, ultisnip)
      if (!emptyRange(range)) {
        // same behavior as Ultisnips
        await doc.applyEdits([{ range, newText: '' }])
        await window.moveTo(range.start)
        range.end = Object.assign({}, range.start)
      }
    }
    if (session) {
      await session.forceSynchronize()
      // current session could be canceled on sychronize.
      session = this.getSession(bufnr)
    }
    if (!session) {
      session = new SnippetSession(workspace.nvim, bufnr, this.highlight, this.preferComplete)
      session.onCancel(() => {
        this.sessionMap.delete(bufnr)
        this.statusItem.hide()
      })
    }
    let isActive = await session.start(inserted, range, select, context)
    if (isActive) {
      this.statusItem.show()
      this.sessionMap.set(bufnr, session)
    } else {
      this.statusItem.hide()
      this.sessionMap.delete(bufnr)
    }
    return isActive
  }

  public async selectCurrentPlaceholder(triggerAutocmd = true): Promise<void> {
    let { session } = this
    if (session) return await session.selectCurrentPlaceholder(triggerAutocmd)
  }

  public async nextPlaceholder(): Promise<string> {
    let { session } = this
    if (session) {
      await session.nextPlaceholder()
    } else {
      workspace.nvim.call('coc#snippet#disable', [], true)
      this.statusItem.hide()
    }
    return ''
  }

  public async previousPlaceholder(): Promise<string> {
    let { session } = this
    if (session) {
      await session.previousPlaceholder()
    } else {
      workspace.nvim.call('coc#snippet#disable', [], true)
      this.statusItem.hide()
    }
    return ''
  }

  public cancel(): void {
    let session = this.getSession(workspace.bufnr)
    if (session) return session.deactivate()
    workspace.nvim.call('coc#snippet#disable', [], true)
    if (this.statusItem) this.statusItem.hide()
  }

  public get session(): SnippetSession {
    return this.getSession(workspace.bufnr)
  }

  public getSession(bufnr: number): SnippetSession {
    return this.sessionMap.get(bufnr)
  }

  public jumpable(): boolean {
    let { session } = this
    if (!session) return false
    return session.placeholder != null && session.placeholder.index != 0
  }

  public async resolveSnippet(snippetString: string, ultisnip?: UltiSnippetOption): Promise<string> {
    return await SnippetSession.resolveSnippet(workspace.nvim, snippetString, ultisnip)
  }

  public async normalizeInsertText(uri: string, snippetString: string, currentLine: string, insertTextMode: InsertTextMode): Promise<string> {
    let inserted = ''
    if (insertTextMode === InsertTextMode.asIs || !shouldFormat(snippetString)) {
      inserted = snippetString
    } else {
      const currentIndent = currentLine.match(/^\s*/)[0]
      const formatOptions = window.activeTextEditor ? window.activeTextEditor.options : await workspace.getFormatOptions(uri)
      inserted = normalizeSnippetString(snippetString, currentIndent, formatOptions)
    }
    return inserted
  }

  public dispose(): void {
    this.cancel()
    for (let d of this.disposables) {
      d.dispose()
    }
  }
}

export default new SnippetManager()
