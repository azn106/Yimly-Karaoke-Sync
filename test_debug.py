import sys
sys.stderr.write("DEBUG START
")
sys.stderr.flush()
sys.stdout.write("[WORKER_READY]
")
sys.stdout.flush()
while True:
 l = sys.stdin.readline()
 if not l: break
