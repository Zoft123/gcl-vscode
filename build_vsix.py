#!/usr/bin/env python3
"""Package the extension as a .vsix (a zip with [Content_Types].xml + extension.vsixmanifest + extension/...)
without needing vsce:   python3 build_vsix.py   -> gcl-<version>.vsix"""
import json, os, zipfile
from xml.sax.saxutils import escape

HERE = os.path.dirname(os.path.abspath(__file__))
pkg = json.load(open(os.path.join(HERE, 'package.json')))
FILES = ['package.json', 'icon.png', 'extension.js', 'README.md', 'CHANGELOG.md', 'LICENSE', 'language-configuration.json',
         'syntaxes/gcl.tmLanguage.json', 'snippets/gcl.json', 'bin/gcx.js',
         'lib/gcx.js', 'lib/gcltext.js', 'lib/project.js', 'lib/mgo2crypt.js']

manifest = f'''<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="{pkg['name']}" Version="{pkg['version']}" Publisher="{pkg['publisher']}" />
    <DisplayName>{escape(pkg['displayName'])}</DisplayName>
    <Description xml:space="preserve">{escape(pkg['description'])}</Description>
    <Tags>{escape(','.join(pkg.get('keywords', [])))}</Tags>
    <Categories>{escape(','.join(pkg.get('categories', [])))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="{escape(pkg['engines']['vscode'])}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="https://github.com/Zoft123/gcl-vscode.git" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Getstarted" Value="https://github.com/Zoft123/gcl-vscode.git" />
      <Property Id="Microsoft.VisualStudio.Services.Links.GitHub" Value="https://github.com/Zoft123/gcl-vscode.git" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Support" Value="https://github.com/Zoft123/gcl-vscode/issues" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Learn" Value="https://github.com/Zoft123/gcl-vscode#readme" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="#1e1e1e" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Theme" Value="dark" />
    </Properties>
    <License>extension/LICENSE</License>
    <Icon>extension/icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
'''
types = '''<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".md" ContentType="text/markdown"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Override PartName="/extension/LICENSE" ContentType="text/plain"/>
</Types>
'''
out = os.path.join(HERE, '%s-%s.vsix' % (pkg['name'], pkg['version']))
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', types)
    z.writestr('extension.vsixmanifest', manifest)
    for f in FILES:
        z.write(os.path.join(HERE, f), 'extension/' + f)
print('wrote', out, os.path.getsize(out), 'bytes')
