"""Compile native fixture C# without running Windows APIs or modifying SCM.

Usage: DOTNET=/absolute/path/to/dotnet python3 -B tests/office-bootstrap/compile_native_fixture_csharp.py
"""
import os
from pathlib import Path
import subprocess
import tempfile
import xml.sax.saxutils

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[1]
SDK = os.environ.get('DOTNET', '/home/marco/tmp/cabinet-audit-dotnet/dotnet')
SERVICE_REFERENCE = Path(os.environ.get('SERVICE_REFERENCE',
    '/home/marco/.nuget/packages/system.serviceprocess.servicecontroller/8.0.1/lib/net8.0/System.ServiceProcess.ServiceController.dll'))


def between(source, start, end):
    if source.count(start) != 1 or source.count(end) != 1:
        raise ValueError(f'Embedded C# boundaries ambiguous: {start!r}, {end!r}')
    return source.split(start, 1)[1].split(end, 1)[0]


parent = (ROOT / 'Test-ManualReinstallNative.ps1').read_text()
audit = (ROOT / 'Set-DisposableAuditFixture.ps1').read_text()
sources = {
    'InertManual': between(parent, "$source='", "'\n Add-Type -TypeDefinition $source").replace("'+$serviceName+'", 'InertProbe'),
    'ManualFixtureScm': between(parent, "  Add-Type -TypeDefinition @'\n", "\n'@\n  $held="),
    'ManualFixtureAudit': between(audit, "Add-Type -TypeDefinition @'\n", "\n'@\n[ManualFixtureAudit]"),
    'CabinetRecoveryProcess': (REPO / 'tools/RecoveryProcess.cs').read_text(),
}
if not Path(SDK).is_file():
    raise SystemExit(f'BLOCKED: .NET SDK executable unavailable: {SDK}')

with tempfile.TemporaryDirectory(prefix='cabinet-fixture-csharp-') as directory:
    for name, source in sources.items():
        path = Path(directory) / name
        path.mkdir()
        (path / f'{name}.cs').write_text(source)
        reference = ''
        if name == 'InertManual':
            dll = SERVICE_REFERENCE
            if not dll.is_file():
                raise SystemExit(f'BLOCKED: service reference unavailable: {dll}')
            reference = (f'<ItemGroup><Reference Include="System.ServiceProcess.ServiceController">'
                         f'<HintPath>{xml.sax.saxutils.escape(str(dll))}</HintPath></Reference></ItemGroup>')
        (path / f'{name}.csproj').write_text(
            '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>'
            '<TargetFramework>net8.0</TargetFramework><OutputType>Library</OutputType>'
            '<GenerateAssemblyInfo>false</GenerateAssemblyInfo><EnableDefaultCompileItems>false</EnableDefaultCompileItems>'
            '</PropertyGroup><ItemGroup><Compile Include="*.cs" /></ItemGroup>'
            f'{reference}</Project>')
        print(f'COMPILE {name}', flush=True)
        result = subprocess.run([SDK, 'build', str(path / f'{name}.csproj'), '--nologo',
                                 '-v:q', '-p:NuGetAudit=false'], cwd=path,
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                timeout=120)
        print(result.stdout, end='', flush=True)
        if result.returncode:
            raise SystemExit(f'FAIL {name}: exit {result.returncode}')
        print(f'PASS {name}: exit 0', flush=True)
