package com.firetvcast.receiver

import org.bouncycastle.asn1.x500.X500Name
import org.bouncycastle.asn1.x509.BasicConstraints
import org.bouncycastle.asn1.x509.Extension
import org.bouncycastle.asn1.x509.GeneralName
import org.bouncycastle.asn1.x509.GeneralNames
import org.bouncycastle.cert.jcajce.JcaX509v3CertificateBuilder
import org.bouncycastle.operator.jcajce.JcaContentSignerBuilder
import java.io.ByteArrayInputStream
import java.io.File
import java.math.BigInteger
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Date

/**
 * Creates (once) and loads a self-signed TLS certificate.
 *
 * Browsers only allow screen capture (getDisplayMedia) on secure origins, so the page the Mac
 * opens has to be served over HTTPS. The certificate is unique to this TV and stored in the
 * app's private storage, so the browser only asks you to trust it once.
 */
object CertManager {
    private const val ALIAS = "firetvcast"
    val PASSWORD: CharArray = "firetvcast".toCharArray()

    fun loadOrCreate(file: File, ipAddresses: List<String>): KeyStore {
        if (file.exists()) {
            try {
                val ks = KeyStore.getInstance("PKCS12")
                file.inputStream().use { ks.load(it, PASSWORD) }
                if (ks.containsAlias(ALIAS)) return ks
            } catch (e: Exception) {
                // Corrupt keystore: fall through and regenerate.
            }
        }
        val ks = create(ipAddresses)
        file.parentFile?.mkdirs()
        file.outputStream().use { ks.store(it, PASSWORD) }
        return ks
    }

    private fun create(ipAddresses: List<String>): KeyStore {
        val kpg = KeyPairGenerator.getInstance("RSA")
        kpg.initialize(2048, SecureRandom())
        val keyPair = kpg.generateKeyPair()

        val now = System.currentTimeMillis()
        val name = X500Name("CN=Fire TV Cast,O=Fire TV Cast")
        val serial = BigInteger(64, SecureRandom()).abs()
        val builder = JcaX509v3CertificateBuilder(
            name, serial,
            Date(now - 24L * 3600 * 1000),
            Date(now + 3650L * 24 * 3600 * 1000),
            name, keyPair.public,
        )
        builder.addExtension(Extension.basicConstraints, true, BasicConstraints(false))
        val altNames = (ipAddresses.map { GeneralName(GeneralName.iPAddress, it) } +
            GeneralName(GeneralName.dNSName, "localhost")).toTypedArray()
        builder.addExtension(Extension.subjectAlternativeName, false, GeneralNames(altNames))

        // Use the platform's signature provider; BouncyCastle is only needed for the ASN.1 bits.
        val signer = JcaContentSignerBuilder("SHA256withRSA").build(keyPair.private)
        val der = builder.build(signer).encoded
        val cert = CertificateFactory.getInstance("X.509")
            .generateCertificate(ByteArrayInputStream(der)) as X509Certificate

        val ks = KeyStore.getInstance("PKCS12")
        ks.load(null, null)
        ks.setKeyEntry(ALIAS, keyPair.private, PASSWORD, arrayOf(cert))
        return ks
    }
}
