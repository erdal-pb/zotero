/*
    ***** BEGIN LICENSE BLOCK *****
    
    Copyright © 2021 Corporation for Digital Scholarship
                     Vienna, Virginia, USA
                     http://digitalscholar.org/
    
    This file is part of Zotero.
    
    Zotero is free software: you can redistribute it and/or modify
    it under the terms of the GNU Affero General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
    
    Zotero is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU Affero General Public License for more details.
    
    You should have received a copy of the GNU Affero General Public License
    along with Zotero.  If not, see <http://www.gnu.org/licenses/>.
    
    ***** END LICENSE BLOCK *****
*/

import FilePicker from 'zotero/modules/filePicker';

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Invalid_array_length
const ARRAYBUFFER_MAX_LENGTH = Services.appinfo.is64Bit
	? Math.pow(2, 33)
	: Math.pow(2, 32) - 1;

class ReaderInstance {
	constructor(options) {
		this.stateFileName = '.zotero-reader-state';
		this.annotationItemIDs = [];
		this._item = options.item;
		this._instanceID = Zotero.Utilities.randomString();
		this._window = null;
		this._iframeWindow = null;
		this._title = '';
		this._isReaderInitialized = false;
		this._showItemPaneToggle = false;
		this._initPromise = new Promise((resolve, reject) => {
			this._resolveInitPromise = resolve;
			this._rejectInitPromise = reject;
		});
		this._pendingWriteStateTimeout = null;
		this._pendingWriteStateFunction = null;

		switch (this._item.attachmentContentType) {
			case 'application/pdf': this._type = 'pdf'; break;
			case 'application/epub+zip': this._type = 'epub'; break;
			case 'text/html': this._type = 'snapshot'; break;
			default: throw new Error('Unsupported attachment type');
		}

		return new Proxy(this, {
			get(target, prop) {
				if (target[prop] === undefined
					&& target._internalReader
					&& target._internalReader[prop] !== undefined) {
					if (typeof target._internalReader[prop] === 'function') {
						return function (...args) {
							return target._internalReader[prop](...args);
						};
					}
					return target._internalReader[prop];
				}
				return target[prop];
			},
			set(originalTarget, prop, value) {
				let target = originalTarget;
				if (!originalTarget.hasOwnProperty(prop)
					&& originalTarget._internalReader
					&& target._internalReader[prop] !== undefined) {
					target = originalTarget._internalReader;
				}
				target[prop] = value;
				return true;
			}
		});
	}

	get type() {
		return this._type;
	}

	async focus() {
		await this._waitForReader();
		this._iframeWindow.focus();
		this._internalReader?.focus();
	}

	getSecondViewState() {
		let state = this._iframeWindow.wrappedJSObject.getSecondViewState();
		return state ? JSON.parse(JSON.stringify(state)) : undefined;
	}

	async migrateMendeleyColors(libraryID, annotations) {
		let colorMap = new Map();
		colorMap.set('#fff5ad', '#ffd400');
		colorMap.set('#ffb5b6', '#ff6666');
		colorMap.set('#bae2ff', '#2ea8e5');
		colorMap.set('#d3c2ff', '#a28ae5');
		colorMap.set('#dcffb0', '#5fb236');
		let updatedAnnotations = [];
		for (let annotation of annotations) {
			let color = colorMap.get(annotation.color);
			if (color) {
				annotation.color = color;
				updatedAnnotations.push(annotation);
			}
		}
		if (!updatedAnnotations.length) {
			return false;
		}
		Zotero.debug('Migrating Mendeley colors');
		let notifierQueue = new Zotero.Notifier.Queue();
		try {
			for (let annotation of updatedAnnotations) {
				let { id: key, color } = annotation;
				let item = Zotero.Items.getByLibraryAndKey(libraryID, key);
				if (item && item.isEditable()) {
					item.annotationColor = color;
					await item.saveTx({ skipDateModifiedUpdate: true, notifierQueue });
				}
			}
		}
		finally {
			await Zotero.Notifier.commit(notifierQueue);
		}
		return true;
	}

	displayError(error) {
		if (this._internalReader) {
			let errorMessage = `${Zotero.getString('general.error')}: '${error.message}'`;
			this._internalReader.setErrorMessage(errorMessage);
		}
	}

	async _open({ state, location, secondViewState }) {
		// Set `ReaderTab` title as fast as possible
		this.updateTitle();

		let data = await this._getData();
		let annotationItems = this._item.getAnnotations();
		let annotations = (await Promise.all(annotationItems.map(x => this._getAnnotation(x)))).filter(x => x);

		// TODO: Remove after some time
		// Migrate Mendeley colors to Zotero PDF reader colors
		let migrated = await this.migrateMendeleyColors(this._item.libraryID, annotations);
		if (migrated) {
			annotationItems = this._item.getAnnotations();
			annotations = (await Promise.all(annotationItems.map(x => this._getAnnotation(x)))).filter(x => x);
		}

		this.annotationItemIDs = annotationItems.map(x => x.id);
		state = state || await this._getState();


		await this._waitForReader();

		// A custom print function to work around Zotero 7 printing issues
		this._iframeWindow.wrappedJSObject.zoteroPrint = async () => {
			let win = Zotero.getMainWindow();
			if (win) {
				let { PrintUtils } = win;
				let settings = PrintUtils.getPrintSettings("", false);
				let doPrint = await PrintUtils.handleSystemPrintDialog(
					this._iframeWindow.browsingContext.topChromeWindow, false, settings
				);
				if (doPrint) {
					this._iframeWindow.browsingContext.print(settings);
					// An ugly hack to close the browser window that has a static clone
					// of the content that is being printed. Without this, the window
					// will be open while transferring the content into system print queue,
					// which can take time for large PDF files
					let win = Services.wm.getMostRecentWindow("navigator:browser");
					if (win?.document?.getElementById('statuspanel')) {
						win.close();
					}
				}
			}
		};

		this._iframeWindow.addEventListener('customEvent', (event) => {
			let data = event.detail.wrappedJSObject;
			let append = data.append;
			data.append = (...args) => {
				append(...Components.utils.cloneInto(args, this._iframeWindow, { wrapReflectors: true, cloneFunctions: true }));
			};
			data.reader = this;
			Zotero.Reader._dispatchEvent(data);
		});

		this._internalReader = this._iframeWindow.wrappedJSObject.createReader(Components.utils.cloneInto({
			type: this._type,
			data,
			annotations,
			primaryViewState: state,
			secondaryViewState: secondViewState,
			location,
			readOnly: this._isReadOnly(),
			authorName: this._item.library.libraryType === 'group' ? Zotero.Users.getCurrentName() : '',
			showItemPaneToggle: this._showItemPaneToggle,
			sidebarWidth: this._sidebarWidth,
			sidebarOpen: this._sidebarOpen,
			bottomPlaceholderHeight: this._bottomPlaceholderHeight,
			rtl: Zotero.rtl,
			fontSize: Zotero.Prefs.get('fontSize'),
			localizedStrings: {
				...Zotero.Intl.getPrefixedStrings('general.'),
				...Zotero.Intl.getPrefixedStrings('pdfReader.')
			},
			showAnnotations: true,
			fontFamily: Zotero.Prefs.get('reader.ebookFontFamily'),
			onOpenContextMenu: () => {
				// Functions can only be passed over wrappedJSObject (we call back onClick for context menu items)
				this._openContextMenu(this._iframeWindow.wrappedJSObject.contextMenuParams);
			},
			onAddToNote: (annotations) => {
				this._addToNote(annotations);
			},
			onSaveAnnotations: async (annotations) => {
				let attachment = Zotero.Items.get(this.itemID);
				let notifierQueue = new Zotero.Notifier.Queue();
				try {
					for (let annotation of annotations) {
						annotation.key = annotation.id;
						let saveOptions = {
							notifierQueue,
							notifierData: {
								instanceID: this._instanceID
							}
						};

						if (annotation.onlyTextOrComment) {
							saveOptions.notifierData.autoSyncDelay = Zotero.Notes.AUTO_SYNC_DELAY;
						}

						let item = Zotero.Items.getByLibraryAndKey(attachment.libraryID, annotation.key);
						// If annotation isn't editable, only save image to cache.
						// This is the only case when saving can be triggered for non-editable annotation
						if (annotation.image && item && !item.isEditable()) {
							let blob = this._dataURLtoBlob(annotation.image);
							await Zotero.Annotations.saveCacheImage(item, blob);
						}
						// Save annotation, and save image to cache
						else {
							// Delete authorName to prevent setting annotationAuthorName unnecessarily
							delete annotation.authorName;
							let savedAnnotation = await Zotero.Annotations.saveFromJSON(attachment, annotation, saveOptions);
							if (annotation.image) {
								let blob = this._dataURLtoBlob(annotation.image);
								await Zotero.Annotations.saveCacheImage(savedAnnotation, blob);
							}
						}
					}
				}
				catch (e) {
					// Enter read-only mode if annotation saving fails
					this.displayError(e);
					this._internalReader.setReadOnly(true);
					throw e;
				}
				finally {
					await Zotero.Notifier.commit(notifierQueue);
				}
			},
			onDeleteAnnotations: async (ids) => {
				let keys = ids;
				let attachment = this._item;
				let libraryID = attachment.libraryID;
				let notifierQueue = new Zotero.Notifier.Queue();
				try {
					for (let key of keys) {
						let annotation = Zotero.Items.getByLibraryAndKey(libraryID, key);
						// Make sure the annotation actually belongs to the current PDF
						if (annotation && annotation.isAnnotation() && annotation.parentID === this._item.id) {
							this.annotationItemIDs = this.annotationItemIDs.filter(id => id !== annotation.id);
							await annotation.eraseTx({ notifierQueue });
						}
					}
				}
				catch (e) {
					this.displayError(e);
					throw e;
				}
				finally {
					await Zotero.Notifier.commit(notifierQueue);
				}
			},
			onChangeViewState: async (state, primary) => {
				state = JSON.parse(JSON.stringify(state));
				if (primary) {
					await this._setState(state);
				}
				else if (this.tabID) {
					let win = Zotero.getMainWindow();
					if (win) {
						win.Zotero_Tabs.setSecondViewState(this.tabID, state);
					}
				}
			},
			onOpenTagsPopup: (id, x, y) => {
				let key = id;
				let attachment = Zotero.Items.get(this._item.id);
				let libraryID = attachment.libraryID;
				let annotation = Zotero.Items.getByLibraryAndKey(libraryID, key);
				if (annotation) {
					this._openTagsPopup(annotation, x, y);
				}
			},
			onClosePopup: () => {
				// Note: This currently only closes tags popup when annotations are
				// disappearing from pdf-reader sidebar
				for (let child of Array.from(this._popupset.children)) {
					if (child.classList.contains('tags-popup')) {
						child.hidePopup();
					}
				}
			},
			onOpenLink: (url) => {
				let win = Services.wm.getMostRecentWindow('navigator:browser');
				if (win) {
					win.ZoteroPane.loadURI(url);
				}
			},
			onToggleSidebar: (open) => {
				if (this._onToggleSidebarCallback) {
					this._onToggleSidebarCallback(open);
				}
			},
			onChangeSidebarWidth: (width) => {
				if (this._onChangeSidebarWidthCallback) {
					this._onChangeSidebarWidthCallback(width);
				}
			},
			onFocusSplitButton: () => {
				if (this instanceof ReaderTab) {
					let win = Zotero.getMainWindow();
					if (win) {
						win.document.getElementById('zotero-tb-toggle-item-pane').focus();
					}
				}
			},
			onFocusContextPane: () => {
				if (this instanceof ReaderWindow || !this._window.ZoteroContextPane.focus()) {
					this.focusFirst();
				}
			},
			onSetDataTransferAnnotations: (dataTransfer, annotations, fromText) => {
				try {
					// A little hack to force serializeAnnotations to include image annotation
					// even if image isn't saved and imageAttachmentKey isn't available
					for (let annotation of annotations) {
						annotation.attachmentItemID = this._item.id;
					}
					dataTransfer.setData('zotero/annotation', JSON.stringify(annotations));
					// Don't set Markdown or HTML if copying or dragging text
					if (fromText) {
						return;
					}
					for (let annotation of annotations) {
						if (annotation.image && !annotation.imageAttachmentKey) {
							annotation.imageAttachmentKey = 'none';
							delete annotation.image;
						}
					}
					let res = Zotero.EditorInstanceUtilities.serializeAnnotations(annotations);
					let tmpNote = new Zotero.Item('note');
					tmpNote.libraryID = Zotero.Libraries.userLibraryID;
					tmpNote.setNote(res.html);
					let items = [tmpNote];
					let format = Zotero.QuickCopy.getNoteFormat();
					Zotero.debug(`Copying/dragging (${annotations.length}) annotation(s) with ${format}`);
					format = Zotero.QuickCopy.unserializeSetting(format);
					// Basically the same code is used in itemTree.jsx onDragStart
					if (format.mode === 'export') {
						// If exporting with virtual "Markdown + Rich Text" translator, call Note Markdown
						// and Note HTML translators instead
						if (format.id === Zotero.Translators.TRANSLATOR_ID_MARKDOWN_AND_RICH_TEXT) {
							let markdownFormat = { mode: 'export', id: Zotero.Translators.TRANSLATOR_ID_NOTE_MARKDOWN, options: format.markdownOptions };
							let htmlFormat = { mode: 'export', id: Zotero.Translators.TRANSLATOR_ID_NOTE_HTML, options: format.htmlOptions };
							Zotero.QuickCopy.getContentFromItems(items, markdownFormat, (obj, worked) => {
								if (!worked) {
									return;
								}
								Zotero.QuickCopy.getContentFromItems(items, htmlFormat, (obj2, worked) => {
									if (!worked) {
										return;
									}
									dataTransfer.setData('text/plain', obj.string.replace(/\r\n/g, '\n'));
									dataTransfer.setData('text/html', obj2.string.replace(/\r\n/g, '\n'));
								});
							});
						}
						else {
							Zotero.QuickCopy.getContentFromItems(items, format, (obj, worked) => {
								if (!worked) {
									return;
								}
								var text = obj.string.replace(/\r\n/g, '\n');
								// For Note HTML translator use body content only
								if (format.id === Zotero.Translators.TRANSLATOR_ID_NOTE_HTML) {
									// Use body content only
									let parser = new DOMParser();
									let doc = parser.parseFromString(text, 'text/html');
									text = doc.body.innerHTML;
								}
								dataTransfer.setData('text/plain', text);
							});
						}
					}
				}
				catch (e) {
					this.displayError(e);
					throw e;
				}
			},
			onConfirm: function (title, text, confirmationButtonTitle) {
				let ps = Services.prompt;
				let buttonFlags = ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING
					+ ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL;
				let index = ps.confirmEx(null, title, text, buttonFlags,
					confirmationButtonTitle, null, null, null, {});
				return !index;
			},
			onCopyImage: async (dataURL) => {
				try {
					let parts = dataURL.split(',');
					if (!parts[0].includes('base64')) {
						return;
					}
					let mime = parts[0].match(/:(.*?);/)[1];
					let bstr = atob(parts[1]);
					let n = bstr.length;
					let u8arr = new Uint8Array(n);
					while (n--) {
						u8arr[n] = bstr.charCodeAt(n);
					}
					let imgTools = Components.classes["@mozilla.org/image/tools;1"].getService(Components.interfaces.imgITools);
					let transferable = Components.classes['@mozilla.org/widget/transferable;1'].createInstance(Components.interfaces.nsITransferable);
					let clipboardService = Components.classes['@mozilla.org/widget/clipboard;1'].getService(Components.interfaces.nsIClipboard);
					let img = imgTools.decodeImageFromArrayBuffer(u8arr.buffer, mime);
					transferable.init(null);
					let kNativeImageMime = 'application/x-moz-nativeimage';
					transferable.addDataFlavor(kNativeImageMime);
					transferable.setTransferData(kNativeImageMime, img);
					clipboardService.setData(transferable, null, Components.interfaces.nsIClipboard.kGlobalClipboard);
				}
				catch (e) {
					this.displayError(e);
				}
			},
			onSaveImageAs: async (dataURL) => {
				try {
					let fp = new FilePicker();
					fp.init(this._iframeWindow, Zotero.getString('pdfReader.saveImageAs'), fp.modeSave);
					fp.appendFilter("PNG", "*.png");
					fp.defaultString = Zotero.getString('fileTypes.image').toLowerCase() + '.png';
					let rv = await fp.show();
					if (rv === fp.returnOK || rv === fp.returnReplace) {
						let outputPath = fp.file;
						let parts = dataURL.split(',');
						if (parts[0].includes('base64')) {
							let bstr = atob(parts[1]);
							let n = bstr.length;
							let u8arr = new Uint8Array(n);
							while (n--) {
								u8arr[n] = bstr.charCodeAt(n);
							}
							await OS.File.writeAtomic(outputPath, u8arr);
						}
					}
				}
				catch (e) {
					this.displayError(e);
					throw e;
				}
			},
			onRotatePages: async (pageIndexes, degrees) => {
				this._internalReader.freeze();
				try {
					await Zotero.PDFWorker.rotatePages(this._item.id, pageIndexes, degrees, true);
				}
				catch (e) {
					this.displayError(e);
				}
				await this.reload();
				this._internalReader.unfreeze();
			},
			onDeletePages: async (pageIndexes) => {
				if (this._promptToDeletePages(pageIndexes.length)) {
					this._internalReader.freeze();
					try {
						await Zotero.PDFWorker.deletePages(this._item.id, pageIndexes, true);
					}
					catch (e) {
						this.displayError(e);
					}
					await this.reload();
					this._internalReader.unfreeze();
				}
			}
		}, this._iframeWindow, { cloneFunctions: true }));

		this._resolveInitPromise();

		// Set title once again, because `ReaderWindow` isn't loaded the first time
		this.updateTitle();

		this._prefObserverIDs = [
			Zotero.Prefs.registerObserver('fontSize', this._handleFontSizeChange),
			Zotero.Prefs.registerObserver('tabs.title.reader', this._handleTabTitlePrefChange),
			Zotero.Prefs.registerObserver('reader.ebookFontFamily', this._handleFontFamilyChange),
		];

		return true;
	}

	async _getData() {
		let item = Zotero.Items.get(this._item.id);
		let path = await item.getFilePathAsync();
		// Check file size, otherwise we get uncatchable error:
		// JavaScript error: resource://gre/modules/osfile/osfile_native.jsm, line 60: RangeError: invalid array length
		// See more https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Errors/Invalid_array_length
		let fileSize = (await OS.File.stat(path)).size;
		if (fileSize > ARRAYBUFFER_MAX_LENGTH) {
			throw new Error(`The file "${path}" is too large`);
		}
		return {
			url: `zotero://attachment/${Zotero.API.getLibraryPrefix(item.libraryID)}/items/${item.key}/`
		};
	}

	uninit() {
		if (this._prefObserverIDs) {
			this._prefObserverIDs.forEach(id => Zotero.Prefs.unregisterObserver(id));
		}
		this._flushState();
	}

	get itemID() {
		return this._item.id;
	}

	async updateTitle() {
		let type = Zotero.Prefs.get('tabs.title.reader');
		let item = Zotero.Items.get(this._item.id);
		let readerTitle = item.getDisplayTitle();
		let parentItem = item.parentItem;
		if (type === 'filename') {
			readerTitle = item.attachmentFilename;
		}
		else if (parentItem) {
			let attachment = await parentItem.getBestAttachment();
			let isPrimaryAttachment = attachment && attachment.id == item.id;
			
			let parts = [];
			// Windows displays bidi control characters as placeholders in window titles, so strip them
			// See https://github.com/mozilla-services/screenshots/issues/4863
			let unformatted = Zotero.isWin;
			let creator = parentItem.getField('firstCreator', unformatted);
			let year = parentItem.getField('year');
			// Only include parent title if primary attachment
			let title = isPrimaryAttachment ? parentItem.getDisplayTitle() : false;
			// If creator is missing fall back to titleCreatorYear
			if (type === 'creatorYearTitle' && creator) {
				parts = [creator, year, title];
			}
			else if (type === 'title') {
				parts = [title];
			}
			// If type is titleCreatorYear, or is missing, or another type falls back
			else {
				parts = [title, creator, year];
			}
			
			// If not primary attachment, show attachment title first
			if (!isPrimaryAttachment) {
				parts.unshift(item.getDisplayTitle());
			}
			
			readerTitle = parts.filter(Boolean).join(' - ');
		}
		this._title = readerTitle;
		this._setTitleValue(readerTitle);
	}

	async setAnnotations(items) {
		let annotations = [];
		for (let item of items) {
			let annotation = await this._getAnnotation(item);
			if (annotation) {
				annotations.push(annotation);
			}
		}
		if (annotations.length) {
			this._internalReader.setAnnotations(Components.utils.cloneInto(annotations, this._iframeWindow));
		}
	}

	unsetAnnotations(keys) {
		this._internalReader.unsetAnnotations(Components.utils.cloneInto(keys, this._iframeWindow));
	}

	async navigate(location) {
		this._internalReader.navigate(Components.utils.cloneInto(location, this._iframeWindow));
	}

	async enableAddToNote(enable) {
		await this._initPromise;
		this._internalReader.enableAddToNote(enable);
	}

	focusLastToolbarButton() {
		this._iframeWindow.focus();
		// this._postMessage({ action: 'focusLastToolbarButton' });
	}

	tabToolbar(reverse) {
		// this._postMessage({ action: 'tabToolbar', reverse });
		// Avoid toolbar find button being focused for a short moment
		setTimeout(() => this._iframeWindow.focus());
	}

	focusFirst() {
		// this._postMessage({ action: 'focusFirst' });
		setTimeout(() => this._iframeWindow.focus());
	}

	async setBottomPlaceholderHeight(height) {
		await this._initPromise;
		this._internalReader.setBottomPlaceholderHeight(height);
	}

	async setToolbarPlaceholderWidth(width) {
		await this._initPromise;
		this._internalReader.setToolbarPlaceholderWidth(width);
	}

	promptToTransferAnnotations() {
		let ps = Services.prompt;
		let buttonFlags = ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING
			+ ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL;
		let index = ps.confirmEx(
			null,
			Zotero.getString('pdfReader.promptTransferFromPDF.title'),
			Zotero.getString('pdfReader.promptTransferFromPDF.text', Zotero.appName),
			buttonFlags,
			Zotero.getString('general.continue'),
			null, null, null, {}
		);
		return !index;
	}

	_promptToDeletePages(num) {
		let ps = Services.prompt;
		let buttonFlags = ps.BUTTON_POS_0 * ps.BUTTON_TITLE_IS_STRING
			+ ps.BUTTON_POS_1 * ps.BUTTON_TITLE_CANCEL;
		let index = ps.confirmEx(
			null,
			Zotero.getString('pdfReader.promptDeletePages.title'),
			Zotero.getString(
				'pdfReader.promptDeletePages.text',
				new Intl.NumberFormat().format(num),
				num
			),
			buttonFlags,
			Zotero.getString('general.continue'),
			null, null, null, {}
		);
		return !index;
	}

	async reload() {
		let data = await this._getData();
		this._internalReader.reload(Components.utils.cloneInto(data, this._iframeWindow));
	}

	async transferFromPDF() {
		if (this.promptToTransferAnnotations(true)) {
			try {
				await Zotero.PDFWorker.import(this._item.id, true, '', true);
			}
			catch (e) {
				if (e.name === 'PasswordException') {
					Zotero.alert(null, Zotero.getString('general.error'),
						Zotero.getString('pdfReader.promptPasswordProtected'));
				}
				throw e;
			}
		}
	}

	export() {
		let zp = Zotero.getActiveZoteroPane();
		zp.exportPDF(this._item.id);
	}

	showInLibrary() {
		let win = Zotero.getMainWindow();
		if (win) {
			let item = Zotero.Items.get(this._item.id);
			let id = item.parentID || item.id;
			win.ZoteroPane.selectItems([id]);
			win.Zotero_Tabs.select('zotero-pane');
			win.focus();
		}
	}

	async _setState(state) {
		let item = Zotero.Items.get(this._item.id);
		if (item) {
			if (this._type === 'pdf') {
				item.setAttachmentLastPageIndex(state.pageIndex);
			}
			else if (this._type === 'epub') {
				item.setAttachmentLastPageIndex(state.cfi);
			}
			else if (this._type === 'snapshot') {
				item.setAttachmentLastPageIndex(state.scrollYPercent);
			}
			let file = Zotero.Attachments.getStorageDirectory(item);
			if (!await OS.File.exists(file.path)) {
				await Zotero.Attachments.createDirectoryForItem(item);
			}
			file.append(this.stateFileName);
			
			// Write the new state to disk
			let path = file.path;

			// State updates can be frequent (every scroll) and we need to debounce actually writing them to disk.
			// We flush the debounced write operation when Zotero shuts down or the window/tab is closed.
			if (this._pendingWriteStateTimeout) {
				clearTimeout(this._pendingWriteStateTimeout);
			}
			this._pendingWriteStateFunction = async () => {
				if (this._pendingWriteStateTimeout) {
					clearTimeout(this._pendingWriteStateTimeout);
				}
				this._pendingWriteStateFunction = null;
				this._pendingWriteStateTimeout = null;
				
				Zotero.debug('Writing reader state to ' + path);
				// Using atomic `writeJSON` instead of `putContentsAsync` to avoid using temp file that causes conflicts
				// on simultaneous writes (on slow systems)
				await IOUtils.writeJSON(path, state);
			};
			this._pendingWriteStateTimeout = setTimeout(this._pendingWriteStateFunction, 5000);
		}
	}
	
	async _flushState() {
		if (this._pendingWriteStateFunction) {
			await this._pendingWriteStateFunction();
		}
	}

	async _getState() {
		let state;
		let item = Zotero.Items.get(this._item.id);
		let directory = Zotero.Attachments.getStorageDirectory(item);
		let file = directory.clone();
		file.append(this.stateFileName);
		try {
			if (await OS.File.exists(file.path)) {
				state = JSON.parse(await Zotero.File.getContentsAsync(file.path));
			}
		}
		catch (e) {
			Zotero.logError(e);
		}
		// Try to fall back to the older .zotero-pdf-state file
		if (!state && this._type === 'pdf') {
			let file = directory.clone();
			file.append('.zotero-pdf-state');
			try {
				if (await OS.File.exists(file.path)) {
					state = JSON.parse(await Zotero.File.getContentsAsync(file.path));
				}
			}
			catch (e) {
				Zotero.logError(e);
			}
		}

		if (this._type === 'pdf') {
			let pageIndex = item.getAttachmentLastPageIndex();
			if (state) {
				if (Number.isInteger(pageIndex) && state.pageIndex !== pageIndex) {
					state.pageIndex = pageIndex;
					delete state.top;
					delete state.left;
				}
				return state;
			}
			else if (Number.isInteger(pageIndex)) {
				return { pageIndex };
			}
		}
		else if (this._type === 'epub') {
			let cfi = item.getAttachmentLastPageIndex();
			if (state) {
				state.cfi = cfi;
				return state;
			}
			else {
				return { cfi };
			}
		}
		else if (this._type === 'snapshot') {
			let scrollYPercent = item.getAttachmentLastPageIndex();
			if (state) {
				state.scrollYPercent = scrollYPercent;
				return state;
			}
			else {
				return { scrollYPercent };
			}
		}
		return null;
	}

	_isReadOnly() {
		let item = Zotero.Items.get(this._item.id);
		return !item.isEditable()
			|| item.deleted
			|| item.parentItem && item.parentItem.deleted;
	}

	_handleFontSizeChange = () => {
		this._internalReader.setFontSize(Zotero.Prefs.get('fontSize'));
	};

	_handleTabTitlePrefChange = async () => {
		await this.updateTitle();
	};

	_handleFontFamilyChange = () => {
		this._internalReader.setFontFamily(Zotero.Prefs.get('reader.ebookFontFamily'));
	};

	_dataURLtoBlob(dataurl) {
		let parts = dataurl.split(',');
		let mime = parts[0].match(/:(.*?);/)[1];
		if (parts[0].indexOf('base64') !== -1) {
			let bstr = atob(parts[1]);
			let n = bstr.length;
			let u8arr = new Uint8Array(n);
			while (n--) {
				u8arr[n] = bstr.charCodeAt(n);
			}
			return new this._iframeWindow.Blob([u8arr], { type: mime });
		}
	}

	_getColorIcon(color, selected) {
		let stroke = selected ? '%23555' : 'transparent';
		let fill = '%23' + color.slice(1);
		return `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect shape-rendering="geometricPrecision" fill="${fill}" stroke-width="2" x="2" y="2" stroke="${stroke}" width="12" height="12" rx="3"/></svg>`;
	}

	_openTagsPopup(item, x, y) {
		let menupopup = this._window.document.createXULElement('menupopup');
		menupopup.addEventListener('popuphidden', function (event) {
			if (event.target === menupopup) {
				menupopup.remove();
			}
		});
		menupopup.className = 'tags-popup';
		menupopup.style.font = 'inherit';
		menupopup.style.minWidth = '300px';
		menupopup.setAttribute('ignorekeys', true);
		let tagsbox = new (this._window.customElements.get('tags-box'));
		menupopup.appendChild(tagsbox);
		tagsbox.setAttribute('flex', '1');
		this._popupset.appendChild(menupopup);
		let rect = this._iframe.getBoundingClientRect();
		x += rect.left;
		y += rect.top;
		setTimeout(() => menupopup.openPopup(null, 'before_start', x, y, true));
		tagsbox.mode = 'edit';
		tagsbox.item = item;
		if (tagsbox.mode == 'edit' && tagsbox.count == 0) {
			tagsbox.newTag();
		}
	}

	async _openContextMenu({ x, y, itemGroups }) {
		let popup = this._window.document.createXULElement('menupopup');
		this._popupset.appendChild(popup);
		popup.addEventListener('popuphidden', function () {
			popup.remove();
		});
		let appendItems = (parentNode, itemGroups) => {
			for (let itemGroup of itemGroups) {
				for (let item of itemGroup) {
					if (item.groups) {
						let menu = parentNode.ownerDocument.createXULElement('menu');
						menu.setAttribute('label', item.label);
						let menupopup = parentNode.ownerDocument.createXULElement('menupopup');
						menu.append(menupopup);
						appendItems(menupopup, item.groups);
						parentNode.appendChild(menu);
					}
					else {
						let menuitem = parentNode.ownerDocument.createXULElement('menuitem');
						menuitem.setAttribute('label', item.label);
						menuitem.setAttribute('disabled', item.disabled);
						if (item.color) {
							menuitem.className = 'menuitem-iconic';
							menuitem.setAttribute('image', this._getColorIcon(item.color, item.checked));
						}
						else if (item.checked) {
							menuitem.setAttribute('type', 'checkbox');
							menuitem.setAttribute('checked', item.checked);
						}
						menuitem.addEventListener('command', () => item.onCommand());
						parentNode.appendChild(menuitem);
					}
				}
				if (itemGroups.indexOf(itemGroup) !== itemGroups.length - 1) {
					let separator = parentNode.ownerDocument.createXULElement('menuseparator');
					parentNode.appendChild(separator);
				}
			}
		};
		appendItems(popup, itemGroups);
		let rect = this._iframe.getBoundingClientRect();
		rect = this._window.windowUtils.toScreenRectInCSSUnits(rect.x + x, rect.y + y, 0, 0);
		setTimeout(() => popup.openPopupAtScreen(rect.x, rect.y, true));
	}

	_updateSecondViewState() {
		if (this.tabID) {
			let win = Zotero.getMainWindow();
			if (win) {
				win.Zotero_Tabs.setSecondViewState(this.tabID, this.getSecondViewState());
			}
		}
	}

	async _waitForReader() {
		if (this._isReaderInitialized) {
			return;
		}
		let n = 0;
		while (!this._iframeWindow) {
			if (n >= 500) {
				throw new Error('Waiting for reader failed');
			}
			await Zotero.Promise.delay(10);
			n++;
		}
		this._isReaderInitialized = true;
	}

	/**
	 * Return item JSON in the pdf-reader ready format
	 *
	 * @param {Zotero.Item} item
	 * @returns {Object|null}
	 */
	async _getAnnotation(item) {
		try {
			if (!item || !item.isAnnotation()) {
				return null;
			}
			let json = await Zotero.Annotations.toJSON(item);
			json.id = item.key;
			delete json.key;
			for (let key in json) {
				json[key] = json[key] || '';
			}
			json.tags = json.tags || [];
			return json;
		}
		catch (e) {
			Zotero.logError(e);
			return null;
		}
	}
}

class ReaderTab extends ReaderInstance {
	constructor(options) {
		super(options);
		this._sidebarWidth = options.sidebarWidth;
		this._sidebarOpen = options.sidebarOpen;
		this._bottomPlaceholderHeight = options.bottomPlaceholderHeight;
		this._showItemPaneToggle = true;
		this._onToggleSidebarCallback = options.onToggleSidebar;
		this._onChangeSidebarWidthCallback = options.onChangeSidebarWidth;
		this._window = Services.wm.getMostRecentWindow('navigator:browser');
		let { id, container } = this._window.Zotero_Tabs.add({
			id: options.tabID,
			type: 'reader',
			title: options.title || '',
			index: options.index,
			data: {
				itemID: this._item.id
			},
			select: !options.background,
			preventJumpback: options.preventJumpback
		});
		this.tabID = id;
		this._tabContainer = container;
		
		this._iframe = this._window.document.createXULElement('browser');
		this._iframe.setAttribute('class', 'reader');
		this._iframe.setAttribute('flex', '1');
		this._iframe.setAttribute('type', 'content');
		this._iframe.setAttribute('src', 'resource://zotero/reader/reader.html');
		this._tabContainer.appendChild(this._iframe);
		this._iframe.docShell.windowDraggingAllowed = true;
		
		this._popupset = this._window.document.createXULElement('popupset');
		this._tabContainer.appendChild(this._popupset);
		
		this._window.addEventListener('DOMContentLoaded', this._handleLoad);
		this._window.addEventListener('pointerup', this._handlePointerUp);

		this._iframe.setAttribute('tooltip', 'html-tooltip');

		this._open({ location: options.location, secondViewState: options.secondViewState });
	}
	
	close() {
		this._window.removeEventListener('DOMContentLoaded', this._handleLoad);
		this._window.removeEventListener('pointerup', this._handlePointerUp);
		if (this.tabID) {
			this._window.Zotero_Tabs.close(this.tabID);
		}
	}

	_handleLoad = (event) => {
		if (this._iframe && this._iframe.contentWindow && this._iframe.contentWindow.document === event.target) {
			this._window.removeEventListener('DOMContentLoaded', this._handleLoad);
			this._iframeWindow = this._iframe.contentWindow;
			this._iframeWindow.addEventListener('error', event => Zotero.logError(event.error));
		}
	};

	// This is a nonsense work-around to trigger mouseup and pointerup
	// events in PDF reader iframe when mouse up happens over another iframe
	// i.e. note-editor. There should be a better way to solve this
	_handlePointerUp = (event) => {
		try {
			if (this._window.Zotero_Tabs.selectedID === this.tabID
				&& this._iframeWindow
				&& event.target
				&& event.target.closest
				&& !event.target.closest('#outerContainer')) {
				let evt = new this._iframeWindow.MouseEvent('mouseup', { ...event, bubbles: false });
				this._iframeWindow.dispatchEvent(evt);
				if (evt.defaultPrevented) {
					event.preventDefault();
					return;
				}
				if (evt.clickEventPrevented()) {
					event.preventClickEvent();
				}

				evt = new this._iframeWindow.PointerEvent('pointerup', { ...event, bubbles: false });
				this._iframeWindow.dispatchEvent(evt);
				if (evt.defaultPrevented) {
					event.preventDefault();
				}
			}
		}
		catch (e) {
			// TODO: Find a better solution for this or the whole method
			if (!e.message.includes("can't access dead object")) {
				Zotero.logError(e);
			}
		}
	};

	_setTitleValue(title) {
		this._window.Zotero_Tabs.rename(this.tabID, title);
	}

	_addToNote(annotations) {
		annotations = annotations.map(x => ({ ...x, attachmentItemID: this._item.id }));
		let noteEditor = this._window.ZoteroContextPane && this._window.ZoteroContextPane.getActiveEditor();
		if (!noteEditor) {
			return;
		}
		let editorInstance = noteEditor.getCurrentInstance();
		if (editorInstance) {
			editorInstance.focus();
			editorInstance.insertAnnotations(annotations);
		}
	}
}


class ReaderWindow extends ReaderInstance {
	constructor(options) {
		super(options);
		this._sidebarWidth = options.sidebarWidth;
		this._sidebarOpen = options.sidebarOpen;
		this._bottomPlaceholderHeight = 0;
		this._onClose = options.onClose;

		let win = Services.wm.getMostRecentWindow('navigator:browser');
		if (!win) return;

		this._window = win.open(
			'chrome://zotero/content/reader.xhtml', '', 'chrome,resizable'
		);

		this._window.addEventListener('DOMContentLoaded', (event) => {
			if (event.target === this._window.document) {
				this._popupset = this._window.document.getElementById('zotero-reader-popupset');
				this._window.onGoMenuOpen = this._onGoMenuOpen.bind(this);
				this._window.onViewMenuOpen = this._onViewMenuOpen.bind(this);
				this._window.reader = this;
				this._iframe = this._window.document.getElementById('reader');
				this._iframe.docShell.windowDraggingAllowed = true;
			}

			if (this._iframe.contentWindow && this._iframe.contentWindow.document === event.target) {
				this._iframeWindow = this._window.document.getElementById('reader').contentWindow;
				this._iframeWindow.addEventListener('error', event => Zotero.logError(event.error));
			}

			this._switchReaderSubtype(this._type);
		});

		this._open({ state: options.state, location: options.location, secondViewState: options.secondViewState });
	}

	_switchReaderSubtype(subtype) {
		// Do the same as in standalone.js
		this._window.document.querySelectorAll(
			'.menu-type-reader.pdf, .menu-type-reader.epub, .menu-type-reader.snapshot'
		).forEach(el => el.hidden = true);
		this._window.document.querySelectorAll('.menu-type-reader.' + subtype).forEach(el => el.hidden = false);
	};

	close() {
		this.uninit();
		this._window.close();
		this._onClose();
	}

	_setTitleValue(title) {
		this._window.document.title = title;
	}

	_onViewMenuOpen() {
		if (this._type === 'pdf' || this._type === 'epub') {
			this._window.document.getElementById('view-menuitem-no-spreads').setAttribute('checked', this._internalReader.spreadMode === 0);
			this._window.document.getElementById('view-menuitem-odd-spreads').setAttribute('checked', this._internalReader.spreadMode === 1);
			this._window.document.getElementById('view-menuitem-even-spreads').setAttribute('checked', this._internalReader.spreadMode === 2);
		}
		if (this._type === 'pdf') {
			this._window.document.getElementById('view-menuitem-vertical-scrolling').setAttribute('checked', this._internalReader.scrollMode === 0);
			this._window.document.getElementById('view-menuitem-horizontal-scrolling').setAttribute('checked', this._internalReader.scrollMode === 1);
			this._window.document.getElementById('view-menuitem-wrapped-scrolling').setAttribute('checked', this._internalReader.scrollMode === 2);
			this._window.document.getElementById('view-menuitem-hand-tool').setAttribute('checked', this._internalReader.toolType === 'hand');
			this._window.document.getElementById('view-menuitem-zoom-auto').setAttribute('checked', this._internalReader.zoomAutoEnabled);
			this._window.document.getElementById('view-menuitem-zoom-page-width').setAttribute('checked', this._internalReader.zoomPageWidthEnabled);
			this._window.document.getElementById('view-menuitem-zoom-page-height').setAttribute('checked', this._internalReader.zoomPageHeightEnabled);
		}
		else if (this._type === 'epub') {
			this._window.document.getElementById('view-menuitem-scrolled').setAttribute('checked', this._internalReader.flowMode === 'scrolled');
			this._window.document.getElementById('view-menuitem-paginated').setAttribute('checked', this._internalReader.flowMode === 'paginated');
		}
		this._window.document.getElementById('view-menuitem-split-vertically').setAttribute('checked', this._internalReader.splitType === 'vertical');
		this._window.document.getElementById('view-menuitem-split-horizontally').setAttribute('checked', this._internalReader.splitType === 'horizontal');
	}

	_onGoMenuOpen() {
		let keyBack = this._window.document.getElementById('key_back');
		let keyForward = this._window.document.getElementById('key_forward');

		if (Zotero.isMac) {
			keyBack.setAttribute('key', '[');
			keyBack.setAttribute('modifiers', 'meta');
			keyForward.setAttribute('key', ']');
			keyForward.setAttribute('modifiers', 'meta');
		}
		else {
			keyBack.setAttribute('keycode', 'VK_LEFT');
			keyBack.setAttribute('modifiers', 'alt');
			keyForward.setAttribute('keycode', 'VK_RIGHT');
			keyForward.setAttribute('modifiers', 'alt');
		}

		let menuItemBack = this._window.document.getElementById('go-menuitem-back');
		let menuItemForward = this._window.document.getElementById('go-menuitem-forward');
		menuItemBack.setAttribute('key', 'key_back');
		menuItemForward.setAttribute('key', 'key_forward');

		if (['pdf', 'epub'].includes(this._type)) {
			this._window.document.getElementById('go-menuitem-first-page').setAttribute('disabled', !this._internalReader.canNavigateToFirstPage);
			this._window.document.getElementById('go-menuitem-last-page').setAttribute('disabled', !this._internalReader.canNavigateToLastPage);
		}
		this._window.document.getElementById('go-menuitem-back').setAttribute('disabled', !this._internalReader.canNavigateBack);
		this._window.document.getElementById('go-menuitem-forward').setAttribute('disabled', !this._internalReader.canNavigateForward);
	}
}


class Reader {
	constructor() {
		this._sidebarWidth = 240;
		this._sidebarOpen = false;
		this._bottomPlaceholderHeight = 0;
		this._readers = [];
		this._notifierID = Zotero.Notifier.registerObserver(this, ['item', 'tab'], 'reader');
		this._registeredListeners = [];
		this.onChangeSidebarWidth = null;
		this.onToggleSidebar = null;

		this._debounceSidebarWidthUpdate = Zotero.Utilities.debounce(() => {
			let readers = this._readers.filter(r => r instanceof ReaderTab);
			for (let reader of readers) {
				reader.setSidebarWidth(this._sidebarWidth);
			}
			this._setSidebarState();
		}, 500);

		Zotero.Plugins.addObserver({
			shutdown: ({ id: pluginID }) => {
				this._unregisterEventListenerByPluginID(pluginID);
			}
		});
	}

	_dispatchEvent(event) {
		for (let listener of this._registeredListeners) {
			if (listener.type === event.type) {
				listener.handler(event);
			}
		}
	}

	/**
	 * Inject DOM nodes to reader UI parts:
	 * - renderTextSelectionPopup
	 * - renderSidebarAnnotationHeader
	 * - renderToolbar
	 *
	 * Zotero.Reader.registerEventListener('renderTextSelectionPopup', (event) => {
	 * 	let { reader, doc, params, append } = event;
	 * 	let container = doc.createElement('div');
	 * 	container.append('Loading…');
	 * 	append(container);
	 * 	setTimeout(() => container.replaceChildren('Translated text: ' + params.annotation.text), 1000);
	 * });
	 *
	 *
	 * Add options to context menus:
	 * - createColorContextMenu
	 * - createViewContextMenu
	 * - createAnnotationContextMenu
	 * - createThumbnailContextMenu
	 * - createSelectorContextMenu
	 *
	 * Zotero.Reader.registerEventListener('createAnnotationContextMenu', (event) => {
	 * 	let { reader, params, append } = event;
	 * 	append({
	 * 		label: 'Test',
	 * 		onCommand(){ reader._iframeWindow.alert('Selected annotations: ' + params.ids.join(', ')); }
	 * 	});
	 * });
	 */
	registerEventListener(type, handler, pluginID = undefined) {
		this._registeredListeners.push({ pluginID, type, handler });
	}

	unregisterEventListener(type, handler) {
		this._registeredListeners = this._registeredListeners.filter(x => x.type === type && x.handler === handler);
	}

	_unregisterEventListenerByPluginID(pluginID) {
		this._registeredListeners = this._registeredListeners.filter(x => x.pluginID !== pluginID);
	}
	
	getSidebarWidth() {
		return this._sidebarWidth;
	}
	
	async init() {
		await Zotero.uiReadyPromise;
		Zotero.Session.state.windows
			.filter(x => x.type == 'reader' && Zotero.Items.exists(x.itemID))
			.forEach(x => this.open(x.itemID, null, { title: x.title, openInWindow: true, secondViewState: x.secondViewState }));
	}
	
	_loadSidebarState() {
		let win = Zotero.getMainWindow();
		if (win) {
			let pane = win.document.getElementById('zotero-reader-sidebar-pane');
			this._sidebarOpen = pane.getAttribute('collapsed') == 'false';
			let width = pane.getAttribute('width');
			if (width) {
				this._sidebarWidth = parseInt(width);
			}
		}
	}

	_setSidebarState() {
		let win = Zotero.getMainWindow();
		if (win) {
			let pane = win.document.getElementById('zotero-reader-sidebar-pane');
			pane.setAttribute('collapsed', this._sidebarOpen ? 'false' : 'true');
			pane.setAttribute('width', this._sidebarWidth);
		}
	}
	
	getSidebarOpen() {
		return this._sidebarOpen;
	}
	
	setSidebarWidth(width) {
		this._sidebarWidth = width;
		let readers = this._readers.filter(r => r instanceof ReaderTab);
		for (let reader of readers) {
			reader.setSidebarWidth(width);
		}
		this._setSidebarState();
	}
	
	toggleSidebar(open) {
		this._sidebarOpen = open;
		let readers = this._readers.filter(r => r instanceof ReaderTab);
		for (let reader of readers) {
			reader.toggleSidebar(open);
		}
		this._setSidebarState();
	}
	
	setBottomPlaceholderHeight(height) {
		this._bottomPlaceholderHeight = height;
		let readers = this._readers.filter(r => r instanceof ReaderTab);
		for (let reader of readers) {
			reader.setBottomPlaceholderHeight(height);
		}
	}

	notify(event, type, ids, extraData) {
		if (type === 'tab') {
			if (event === 'close') {
				for (let id of ids) {
					let reader = Zotero.Reader.getByTabID(id);
					if (reader) {
						reader.uninit();
						this._readers.splice(this._readers.indexOf(reader), 1);
					}
				}
			}
			else if (event === 'select') {
				let reader = Zotero.Reader.getByTabID(ids[0]);
				if (reader) {
					this.triggerAnnotationsImportCheck(reader.itemID);
				}
			}
			
			if (event === 'add' || event === 'close') {
				Zotero.Session.debounceSave();
			}
		}
		// Listen for parent item, PDF attachment and its annotations updates
		else if (type === 'item') {
			for (let reader of this._readers.slice()) {
				if (event === 'delete' && ids.includes(reader.itemID)) {
					reader.close();
				}

				// Ignore other notifications if the attachment no longer exists
				let item = Zotero.Items.get(reader.itemID);
				if (item) {
					if (event === 'trash' && (ids.includes(item.id) || ids.includes(item.parentItemID))) {
						reader.close();
					}
					else if (event === 'delete') {
						let disappearedIDs = reader.annotationItemIDs.filter(x => ids.includes(x));
						if (disappearedIDs.length) {
							let keys = disappearedIDs.map(id => extraData[id].key);
							reader.unsetAnnotations(keys);
						}
					}
					else {
						let annotationItems = item.getAnnotations();
						reader.annotationItemIDs = annotationItems.map(x => x.id);
						let affectedAnnotations = annotationItems.filter(({ id }) => (
							ids.includes(id)
							&& !(extraData && extraData[id] && extraData[id].instanceID === reader._instanceID)
						));
						if (affectedAnnotations.length) {
							reader.setAnnotations(affectedAnnotations);
						}
						// Update title if the PDF attachment or the parent item changes
						if (ids.includes(reader.itemID) || ids.includes(item.parentItemID)) {
							reader.updateTitle();
						}
					}
				}
			}
		}
	}
	
	getByTabID(tabID) {
		return this._readers.find(r => (r instanceof ReaderTab) && r.tabID === tabID);
	}
	
	getWindowStates() {
		return this._readers
			.filter(r => r instanceof ReaderWindow)
			.map(r => ({
				type: 'reader',
				itemID: r.itemID,
				title: r._title,
				secondViewState: r.getSecondViewState()
			}));
	}

	async openURI(itemURI, location, options) {
		let item = await Zotero.URI.getURIItem(itemURI);
		if (!item) return;
		await this.open(item.id, location, options);
	}

	async open(itemID, location, { title, tabIndex, tabID, openInBackground, openInWindow, allowDuplicate, secondViewState, preventJumpback } = {}) {
		let { libraryID } = Zotero.Items.getLibraryAndKeyFromID(itemID);
		let library = Zotero.Libraries.get(libraryID);
		await library.waitForDataLoad('item');

		let item = Zotero.Items.get(itemID);
		if (!item) {
			throw new Error('Item does not exist');
		}

		this._loadSidebarState();
		this.triggerAnnotationsImportCheck(itemID);
		let reader;

		// If duplicating is not allowed, and no reader instance is loaded for itemID,
		// try to find an unloaded tab and select it. Zotero.Reader.open will then be called again
		if (!allowDuplicate && !this._readers.find(r => r.itemID === itemID)) {
			let win = Zotero.getMainWindow();
			if (win) {
				let existingTabID = win.Zotero_Tabs.getTabIDByItemID(itemID);
				if (existingTabID) {
					win.Zotero_Tabs.select(existingTabID, false, { location });
					return;
				}
			}
		}

		if (openInWindow) {
			reader = this._readers.find(r => r.itemID === itemID && (r instanceof ReaderWindow));
		}
		else if (!allowDuplicate) {
			reader = this._readers.find(r => r.itemID === itemID);
		}

		if (reader) {
			if (reader instanceof ReaderTab) {
				reader._window.Zotero_Tabs.select(reader.tabID, true);
			}
			
			if (location) {
				reader.navigate(location);
			}
		}
		else if (openInWindow) {
			reader = new ReaderWindow({
				item,
				location,
				secondViewState,
				sidebarWidth: this._sidebarWidth,
				sidebarOpen: this._sidebarOpen,
				bottomPlaceholderHeight: this._bottomPlaceholderHeight,
				onClose: () => {
					this._readers.splice(this._readers.indexOf(reader), 1);
					Zotero.Session.debounceSave();
				}
			});
			this._readers.push(reader);
			Zotero.Session.debounceSave();
		}
		else {
			reader = new ReaderTab({
				item,
				location,
				secondViewState,
				title,
				index: tabIndex,
				tabID,
				background: openInBackground,
				sidebarWidth: this._sidebarWidth,
				sidebarOpen: this._sidebarOpen,
				bottomPlaceholderHeight: this._bottomPlaceholderHeight,
				preventJumpback: preventJumpback,
				onToggleSidebar: (open) => {
					this._sidebarOpen = open;
					this.toggleSidebar(open);
					if (this.onToggleSidebar) {
						this.onToggleSidebar(open);
					}
				},
				onChangeSidebarWidth: (width) => {
					this._sidebarWidth = width;
					this._debounceSidebarWidthUpdate();
					if (this.onChangeSidebarWidth) {
						this.onChangeSidebarWidth(width);
					}
				}
			});
			this._readers.push(reader);
		}
		
		if (!openInBackground) {
			reader.focus();
		}
		return reader;
	}

	/**
	 * Trigger annotations import
	 *
	 * @param {Integer} itemID Attachment item id
	 * @returns {Promise}
	 */
	async triggerAnnotationsImportCheck(itemID) {
		let item = await Zotero.Items.getAsync(itemID);
		if (!item.isPDFAttachment()
			|| !item.isEditable()
			|| item.deleted
			|| item.parentItem && item.parentItem.deleted
		) {
			return;
		}
		let mtime = await item.attachmentModificationTime;
		if (item.attachmentLastProcessedModificationTime < Math.floor(mtime / 1000)) {
			await Zotero.PDFWorker.import(itemID, true);
		}
	}
	
	async flushAllReaderStates() {
		for (let reader of this._readers) {
			try {
				await reader._flushState();
			}
			catch (e) {
				Zotero.logError(e);
			}
		}
	}
}

Zotero.Reader = new Reader();
Zotero.addShutdownListener(() => Zotero.Reader.flushAllReaderStates());
