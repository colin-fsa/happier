/** Expo's modern File/Directory SDK boundary, backed by observable UTF-8 bytes. */
export function createExpoFileSystemMock(input: {
    onRead?: (uri: string) => void;
    onWrite?: (uri: string, contents: string) => void;
    onDelete?: (uri: string) => void;
} = {}) {
    const files = new Map<string, string>();
    const uri = (parts: Array<string | { uri: string }>) => parts
        .map((part, index) => {
            const value = typeof part === 'string' ? part : part.uri;
            return index === 0 ? value.replace(/\/+$/, '') : value.replace(/^\/+|\/+$/g, '');
        }).join('/');
    class Directory {
        uri: string;
        constructor(...parts: Array<string | { uri: string }>) { this.uri = uri(parts); }
        create() {}
    }
    class File extends Directory {
        create() { files.set(this.uri, ''); }
        async text() {
            input.onRead?.(this.uri);
            const contents = files.get(this.uri);
            if (contents === undefined) throw new Error(`missing file: ${this.uri}`);
            return contents;
        }
        write(contents: string) { files.set(this.uri, contents); input.onWrite?.(this.uri, contents); }
        open() {
            return {
                offset: 0,
                writeBytes: (bytes: Uint8Array) => this.write((files.get(this.uri) ?? '') + new TextDecoder().decode(bytes)),
                close() {},
            };
        }
        delete() { input.onDelete?.(this.uri); files.delete(this.uri); }
    }
    return { files, module: { Paths: { cache: 'file:///cache/', document: 'file:///documents/' }, Directory, File } };
}
