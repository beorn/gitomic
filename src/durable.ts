/** The in-process directory sync shared by object and repository writers. */
export async function syncDirectory(
  fs: { open(path: string, flags: string): Promise<{ sync(): Promise<void>; close(): Promise<void> }> },
  directory: string,
): Promise<void> {
  const handle = await fs.open(directory, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
