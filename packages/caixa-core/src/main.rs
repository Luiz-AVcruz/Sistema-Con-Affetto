use caixa_core::protocol::evaluate;
use std::io::{self, BufRead, Write};

fn run() -> io::Result<()> {
    if std::env::args_os().len() != 1 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Uso: caixa-core < comandos.jsonl (um comando JSON por linha; não aceita banco)",
        ));
    }
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut output = io::BufWriter::new(stdout.lock());
    for line in stdin.lock().lines() {
        let line = line?;
        let response = evaluate(&line);
        serde_json::to_writer(&mut output, &response)?;
        output.write_all(b"\n")?;
        output.flush()?;
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Não foi possível executar o núcleo Rust: {error}");
        std::process::exit(1);
    }
}
