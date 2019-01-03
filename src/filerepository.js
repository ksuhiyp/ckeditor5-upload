/**
 * @license Copyright (c) 2003-2018, CKSource - Frederico Knabben. All rights reserved.
 * For licensing, see LICENSE.md.
 */

/**
 * @module upload/filerepository
 */

import Plugin from '@ckeditor/ckeditor5-core/src/plugin';

import PendingActions from '@ckeditor/ckeditor5-core/src/pendingactions';
import CKEditorError from '@ckeditor/ckeditor5-utils/src/ckeditorerror';
import ObservableMixin from '@ckeditor/ckeditor5-utils/src/observablemixin';
import Collection from '@ckeditor/ckeditor5-utils/src/collection';
import mix from '@ckeditor/ckeditor5-utils/src/mix';
import log from '@ckeditor/ckeditor5-utils/src/log';

import FileReader from './filereader.js';

import uid from '@ckeditor/ckeditor5-utils/src/uid.js';

/**
 * File repository plugin. A central point for managing file upload.
 *
 * To use it, first you need an upload adapter. Upload adapter's job is to handle communication with the server
 * (sending the file and handling server's response). You can use one of the existing plugins introducing upload adapters
 * (e.g. {@link module:easy-image/cloudservicesuploadadapter~CloudServicesUploadAdapter} or
 * {@link module:adapter-ckfinder/uploadadapter~CKFinderUploadAdapter}) or write your own one – see
 * the {@glink framework/guides/deep-dive/upload-adapter "Custom image upload adpter" deep dive guide}.
 *
 * Then, you can use {@link module:upload/filerepository~FileRepository#createLoader `createLoader()`} and the returned
 * {@link module:upload/filerepository~FileLoader} instance to load and upload files.
 *
 * @extends module:core/plugin~Plugin
 */
export default class FileRepository extends Plugin {
	/**
	 * @inheritDoc
	 */
	static get pluginName() {
		return 'FileRepository';
	}

	/**
	 * @inheritDoc
	 */
	static get requires() {
		return [ PendingActions ];
	}

	/**
	 * @inheritDoc
	 */
	init() {
		/**
		 * Collection of loaders associated with this repository.
		 *
		 * @member {module:utils/collection~Collection} #loaders
		 */
		this.loaders = new Collection();

		// Keeps upload in a sync with pending actions.
		this.loaders.on( 'add', () => this._updatePendingAction() );
		this.loaders.on( 'remove', () => this._updatePendingAction() );

		/**
		 * Loaders mappings used to retrieve loaders references.
		 *
		 * @private
		 * @member {Map<File|Promise, FileLoader>} #_loadersMap
		 */
		this._loadersMap = new Map();

		/**
		 * Reference to a pending action registered in a {@link module:core/pendingactions~PendingActions} plugin
		 * while upload is in progress. When there is no upload then value is `null`.
		 *
		 * @private
		 * @member {Object} #_pendingAction
		 */
		this._pendingAction = null;

		/**
		 * A factory function which should be defined before using `FileRepository`.
		 *
		 * It should return a new instance of {@link module:upload/filerepository~UploadAdapter} that will be used to upload files.
		 * {@link module:upload/filerepository~FileLoader} instance associated with the adapter
		 * will be passed to that function.
		 *
		 * For more information and example see {@link module:upload/filerepository~UploadAdapter}.
		 *
		 * @member {Function} #createUploadAdapter
		 */

		/**
		 * Number of bytes uploaded.
		 *
		 * @readonly
		 * @observable
		 * @member {Number} #uploaded
		 */
		this.set( 'uploaded', 0 );

		/**
		 * Number of total bytes to upload.
		 *
		 * It might be different than the file size because of headers and additional data.
		 * It contains `null` if value is not available yet, so it's better to use {@link #uploadedPercent} to monitor
		 * the progress.
		 *
		 * @readonly
		 * @observable
		 * @member {Number|null} #uploadTotal
		 */
		this.set( 'uploadTotal', null );

		/**
		 * Upload progress in percents.
		 *
		 * @readonly
		 * @observable
		 * @member {Number} #uploadedPercent
		 */
		this.bind( 'uploadedPercent' ).to( this, 'uploaded', this, 'uploadTotal', ( uploaded, total ) => {
			return total ? ( uploaded / total * 100 ) : 0;
		} );
	}

	/**
	 * Returns the loader associated with specified file or promise.
	 *
	 * To get loader by id use `fileRepository.loaders.get( id )`.
	 *
	 * @param {File|Promise} fileOrPromise Native file or promise handle.
	 * @returns {module:upload/filerepository~FileLoader|null}
	 */
	getLoader( fileOrPromise ) {
		return this._loadersMap.get( fileOrPromise ) || null;
	}

	/**
	 * Creates a loader instance for the given file.
	 *
	 * Requires {@link #createUploadAdapter} factory to be defined.
	 *
	 * @param {File|Promise} fileOrPromise Native File object or native Promise object which resolves to a File.
	 * @returns {module:upload/filerepository~FileLoader|null}
	 */
	createLoader( fileOrPromise ) {
		if ( !this.createUploadAdapter ) {
			/**
			 * You need to enable an upload adapter in order to be able to upload files.
			 *
			 * This warning shows up when {@link module:upload/filerepository~FileRepository} is being used
			 * without {@link #createUploadAdapter definining an upload adapter}.
			 *
			 * **If you see this warning when using one of the {@glink builds/index CKEditor 5 Builds}**
			 * it means that you did not configure any of the upload adapters available by default in those builds.
			 *
			 * See the {@glink features/image-upload/image-upload comprehensive "Image upload overview"} to learn which upload
			 * adapters are available in the builds and how to configure them.
			 *
			 * **If you see this warning when using a custom build** there is a chance that you enabled
			 * a feature like {@link module:image/imageupload~ImageUpload},
			 * or {@link module:image/imageupload/imageuploadui~ImageUploadUI} but you did not enable any upload adapter.
			 * You can choose one of the existing upload adapters listed in the
			 * {@glink features/image-upload/image-upload "Image upload overview"}.
			 *
			 * You can also implement your {@glink framework/guides/deep-dive/upload-adapter own image upload adapter}.
			 *
			 * @error filerepository-no-upload-adapter
			 */
			log.error( 'filerepository-no-upload-adapter: Upload adapter is not defined.' );

			return null;
		}

		const filePromise = fileOrPromise instanceof Promise ? fileOrPromise : new Promise( resolve => resolve( fileOrPromise ) );
		const loader = new FileLoader( filePromise );

		loader._adapter = this.createUploadAdapter( loader );

		this.loaders.add( loader );
		this._loadersMap.set( fileOrPromise, loader );

		// Store also file => loader mapping so loader can be retrieved by file instance returned upon Promise resolution.
		if ( fileOrPromise instanceof Promise ) {
			loader.file.then( file => {
				this._loadersMap.set( file, loader );
			} );
		}

		loader.on( 'change:uploaded', () => {
			let aggregatedUploaded = 0;

			for ( const loader of this.loaders ) {
				aggregatedUploaded += loader.uploaded;
			}

			this.uploaded = aggregatedUploaded;
		} );

		loader.on( 'change:uploadTotal', () => {
			let aggregatedTotal = 0;

			for ( const loader of this.loaders ) {
				if ( loader.uploadTotal ) {
					aggregatedTotal += loader.uploadTotal;
				}
			}

			this.uploadTotal = aggregatedTotal;
		} );

		return loader;
	}

	/**
	 * Destroys the given loader.
	 *
	 * @param {File|Promise|module:upload/filerepository~FileLoader} fileOrPromiseOrLoader File or Promise associated
	 * with that loader or loader itself.
	 */
	destroyLoader( fileOrPromiseOrLoader ) {
		const loader = fileOrPromiseOrLoader instanceof FileLoader ? fileOrPromiseOrLoader : this.getLoader( fileOrPromiseOrLoader );

		loader._destroy();

		this.loaders.remove( loader );

		this._loadersMap.forEach( ( value, key ) => {
			if ( value === loader ) {
				this._loadersMap.delete( key );
			}
		} );
	}

	/**
	 * Registers or deregisters pending action bound with upload progress.
	 *
	 * @private
	 */
	_updatePendingAction() {
		const pendingActions = this.editor.plugins.get( PendingActions );

		if ( this.loaders.length ) {
			if ( !this._pendingAction ) {
				const t = this.editor.t;
				const getMessage = value => `${ t( 'Upload in progress' ) } ${ parseInt( value ) }%.`;

				this._pendingAction = pendingActions.add( getMessage( this.uploadedPercent ) );
				this._pendingAction.bind( 'message' ).to( this, 'uploadedPercent', getMessage );
			}
		} else {
			pendingActions.remove( this._pendingAction );
			this._pendingAction = null;
		}
	}
}

mix( FileRepository, ObservableMixin );

/**
 * File loader class.
 *
 * It is used to control the process of reading the file and uploading it using the specified upload adapter.
 */
class FileLoader {
	/**
	 * Creates a new instance of `FileLoader`.
	 *
	 * @param {File} file A native file instance.
	 * @param {module:upload/filerepository~UploadAdapter} adapter
	 */
	constructor( file, adapter ) {
		/**
		 * Unique id of FileLoader instance.
		 *
		 * @readonly
		 * @member {Number}
		 */
		this.id = uid();

		/**
		 * Additional wrapper over a file promise passed to this loader.
		 *
		 * @see #_createFilePromiseWrapper
		 * @private
		 * @member {Object} wrapper
		 */
		this._filePromiseWrapper = this._createFilePromiseWrapper( file );

		/**
		 * Adapter instance associated with this file loader.
		 *
		 * @private
		 * @member {module:upload/filerepository~UploadAdapter}
		 */
		this._adapter = adapter;

		/**
		 * FileReader used by FileLoader.
		 *
		 * @protected
		 * @member {module:upload/filereader~FileReader}
		 */
		this._reader = new FileReader();

		/**
		 * Current status of FileLoader. It can be one of the following:
		 *
		 * * 'idle',
		 * * 'reading',
		 * * 'uploading',
		 * * 'aborted',
		 * * 'error'.
		 *
		 * When reading status can change in a following way:
		 *
		 * `idle` -> `reading` -> `idle`
		 * `idle` -> `reading -> `aborted`
		 * `idle` -> `reading -> `error`
		 *
		 * When uploading status can change in a following way:
		 *
		 * `idle` -> `uploading` -> `idle`
		 * `idle` -> `uploading` -> `aborted`
		 * `idle` -> `uploading` -> `error`
		 *
		 * @readonly
		 * @observable
		 * @member {String} #status
		 */
		this.set( 'status', 'idle' );

		/**
		 * Number of bytes uploaded.
		 *
		 * @readonly
		 * @observable
		 * @member {Number} #uploaded
		 */
		this.set( 'uploaded', 0 );

		/**
		 * Number of total bytes to upload.
		 *
		 * @readonly
		 * @observable
		 * @member {Number|null} #uploadTotal
		 */
		this.set( 'uploadTotal', null );

		/**
		 * Upload progress in percents.
		 *
		 * @readonly
		 * @observable
		 * @member {Number} #uploadedPercent
		 */
		this.bind( 'uploadedPercent' ).to( this, 'uploaded', this, 'uploadTotal', ( uploaded, total ) => {
			return total ? ( uploaded / total * 100 ) : 0;
		} );

		/**
		 * Response of the upload.
		 *
		 * @readonly
		 * @observable
		 * @member {Object|null} #uploadResponse
		 */
		this.set( 'uploadResponse', null );
	}

	/**
	 * Returns a `Promise` which resolves to a `File` instance associated with this file loader.
	 *
	 * @type {Promise}
	 */
	get file() {
		if ( !this._filePromiseWrapper ) {
			// Loader was destroyed, return promise which resolves to null.
			return new Promise( resolve => resolve( null ) );
		} else {
			// The `loader.file.then( ... )` can be called, then `loader._destroy()` (which is sync) and then
			// `loader.file.then( ... )` will be resolved. In such case, even after `destroy` call the promise will
			// return `File` instance so we use nested promises which handles this case.
			return this._filePromiseWrapper.promise.then( file => {
				return new Promise( resolve => resolve( this._filePromiseWrapper ? file : null ) );
			} );
		}
	}

	/**
	 * Reads file using {@link module:upload/filereader~FileReader}.
	 *
	 * Throws {@link module:utils/ckeditorerror~CKEditorError CKEditorError} `filerepository-read-wrong-status` when status
	 * is different than `idle`.
	 *
	 * Example usage:
	 *
	 *	fileLoader.read()
	 *		.then( data => { ... } )
	 *		.catch( err => {
	 *			if ( err === 'aborted' ) {
	 *				console.log( 'Reading aborted.' );
	 *			} else {
	 *				console.log( 'Reading error.', err );
	 *			}
	 *		} );
	 *
	 * @returns {Promise} Returns promise that will be resolved with read data. Promise will be rejected if error
	 * occurs or if read process is aborted.
	 */
	read() {
		if ( this.status != 'idle' ) {
			throw new CKEditorError( 'filerepository-read-wrong-status: You cannot call read if the status is different than idle.' );
		}

		this.status = 'reading';

		return this._filePromiseWrapper.promise
			.then( file => this._reader.read( file ) )
			.then( data => {
				this.status = 'idle';

				return data;
			} )
			.catch( err => {
				if ( err === 'aborted' ) {
					this.status = 'aborted';
					throw 'aborted';
				}

				this.status = 'error';
				throw this._reader.error ? this._reader.error : err;
			} );
	}

	/**
	 * Reads file using the provided {@link module:upload/filerepository~UploadAdapter}.
	 *
	 * Throws {@link module:utils/ckeditorerror~CKEditorError CKEditorError} `filerepository-upload-wrong-status` when status
	 * is different than `idle`.
	 * Example usage:
	 *
	 *	fileLoader.upload()
	 *		.then( data => { ... } )
	 *		.catch( e => {
	 *			if ( e === 'aborted' ) {
	 *				console.log( 'Uploading aborted.' );
	 *			} else {
	 *				console.log( 'Uploading error.', e );
	 *			}
	 *		} );
	 *
	 * @returns {Promise} Returns promise that will be resolved with response data. Promise will be rejected if error
	 * occurs or if read process is aborted.
	 */
	upload() {
		if ( this.status != 'idle' ) {
			throw new CKEditorError( 'filerepository-upload-wrong-status: You cannot call upload if the status is different than idle.' );
		}

		this.status = 'uploading';

		return this._filePromiseWrapper.promise
			.then( () => this._adapter.upload() )
			.then( data => {
				this.uploadResponse = data;
				this.status = 'idle';

				return data;
			} )
			.catch( err => {
				if ( this.status === 'aborted' ) {
					throw 'aborted';
				}

				this.status = 'error';
				throw err;
			} );
	}

	/**
	 * Aborts loading process.
	 */
	abort() {
		const status = this.status;
		this.status = 'aborted';

		if ( !this._filePromiseWrapper.isFulfilled ) {
			this._filePromiseWrapper.rejecter( 'aborted' );
		} else if ( status == 'reading' ) {
			this._reader.abort();
		} else if ( status == 'uploading' && this._adapter.abort ) {
			this._adapter.abort();
		}

		this._destroy();
	}

	/**
	 * Performs cleanup.
	 *
	 * @private
	 */
	_destroy() {
		this._filePromiseWrapper = undefined;
		this._reader = undefined;
		this._adapter = undefined;
		this.data = undefined;
		this.uploadResponse = undefined;
	}

	/**
	 * Wraps a given file promise into another promise giving additional
	 * control (resolving, rejecting, checking if fulfilled) over it.
	 *
	 * @private
	 * @param filePromise The file promise to be wrapped.
	 * @returns {Object}
	 * @returns {Promise} wrapper.promise Wrapper promise.
	 * @returns {Function} wrapper.resolver Resolves the promise when called.
	 * @returns {Function} wrapper.rejecter Rejects the promise when called.
	 * @returns {Boolean} wrapper.isFulfilled Whether original promise is already fulfilled.
	 */
	_createFilePromiseWrapper( filePromise ) {
		const wrapper = {};

		wrapper.promise = new Promise( ( resolve, reject ) => {
			wrapper.resolver = resolve;
			wrapper.rejecter = reject;
			wrapper.isFulfilled = false;

			filePromise
				.then( file => {
					wrapper.isFulfilled = true;
					resolve( file );
				} )
				.catch( err => {
					wrapper.isFulfilled = true;
					reject( err );
				} );
		} );

		return wrapper;
	}
}

mix( FileLoader, ObservableMixin );

/**
 * Upload adapter interface used by the {@link module:upload/filerepository~FileRepository file repository}
 * to handle file upload. An upload adapter is a bridge between the editor and server that handles file uploads.
 * It should contain a logic necessary to initiate an upload process and monitor its progress.
 *
 * Learn how to develop your own upload adapter for CKEditor 5 in the
 * {@glink framework/guides/deep-dive/upload-adapter "Custom upload adapter" guide}.
 *
 * @interface UploadAdapter
 */

/**
 * Executes the upload process.
 * This method should return a promise that will resolve when data will be uploaded to server. Promise should be
 * resolved with an object containing information about uploaded file:
 *
 *		{
 *			default: 'http://server/default-size.image.png'
 *		}
 *
 * Additionally, other image sizes can be provided:
 *
 *		{
 *			default: 'http://server/default-size.image.png',
 *			'160': 'http://server/size-160.image.png',
 *			'500': 'http://server/size-500.image.png',
 *			'1000': 'http://server/size-1000.image.png',
 *			'1052': 'http://server/default-size.image.png'
 *		}
 *
 * NOTE: When returning multiple images, the widest returned one should equal the default one. It is essential to
 * correctly set `width` attribute of the image. See this discussion:
 * https://github.com/ckeditor/ckeditor5-easy-image/issues/4 for more information.
 *
 * Take a look at {@link module:upload/filerepository~UploadAdapter example Adapter implementation} and
 * {@link module:upload/filerepository~FileRepository#createUploadAdapter createUploadAdapter method}.
 *
 * @method module:upload/filerepository~UploadAdapter#upload
 * @returns {Promise} Promise that should be resolved when data is uploaded.
 */

/**
 * Aborts the upload process.
 * After aborting it should reject promise returned from {@link #upload upload()}.
 *
 * Take a look at {@link module:upload/filerepository~UploadAdapter example Adapter implementation} and
 * {@link module:upload/filerepository~FileRepository#createUploadAdapter createUploadAdapter method}.
 *
 * @method module:upload/filerepository~UploadAdapter#abort
 */
